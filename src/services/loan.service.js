import { legacyDecision, legacySubmit } from "./approval/legacy.js";
// src/services/loan.service.js — Loan & salary advance management
import prisma from "../lib/prisma.js";
import { identitiesById } from "../lib/personIdentity.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { lockAttendancePeriod } from "./attendancePeriod.service.js";
import { assertNoPayrollLoanReservation } from "./payrollLoans.service.js";

/** HR-PAYROLL-ADVANCE-01 — mirrors the Prisma `LoanKind` enum. */
export const LOAN_KINDS = ["LOAN", "ADVANCE"];

const MAX_TENURE_MONTHS = 120;
const MAX_PRINCIPAL_MINOR = 100_000_000_000; // 1 billion in major units: a typo guard, not a policy
const MAX_DAYS_AHEAD = 366;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * The basic checks every loan or advance must pass, however it is raised: real amounts and tenure, an advance that is
 * one interest-free instalment, a disbursement date that is a date and not years away, and an active employee of this
 * company. Limits on size and number are the approvers' call, not the system's.
 */
async function checkLoanInput(db, { tenantId, employeeId, principalMinor, interestRatePct = 0, tenureMonths, disbursementDate, kind = "LOAN", reason }) {
    if (!LOAN_KINDS.includes(kind)) throw bad(`kind must be one of ${LOAN_KINDS.join(", ")}`);
    if (!Number.isSafeInteger(principalMinor) || principalMinor <= 0) throw bad("Enter the amount as a positive whole number in minor currency units");
    if (principalMinor > MAX_PRINCIPAL_MINOR) throw bad("That amount is too large");
    if (!Number.isInteger(tenureMonths) || tenureMonths <= 0 || tenureMonths > MAX_TENURE_MONTHS) throw bad(`Repayment months must be a whole number from 1 to ${MAX_TENURE_MONTHS}`);
    const interest = Number(interestRatePct ?? 0);
    if (!Number.isFinite(interest) || interest < 0 || interest > 100) throw bad("Interest must be between 0 and 100 percent");
    if (kind === "ADVANCE") {
        if (interest > 0) throw bad("A salary advance cannot carry interest");
        if (tenureMonths !== 1) throw bad("A salary advance is repaid in one month");
    }
    let disbursed = new Date();
    if (disbursementDate) {
        disbursed = new Date(disbursementDate);
        if (Number.isNaN(disbursed.getTime())) throw bad("Choose a valid disbursement date");
        if (disbursed.getTime() - Date.now() > MAX_DAYS_AHEAD * 86400000) throw bad("The disbursement date cannot be more than a year ahead");
        if (disbursed.getUTCFullYear() < 2000) throw bad("Choose a valid disbursement date");
    }
    const why = String(reason ?? "").trim();
    if (why.length < 3) throw bad("Give a reason (at least 3 characters)");
    const person = await db.employee.findFirst({ where: { id: Number(employeeId), tenant_id: tenantId }, select: { id: true, status: true } });
    if (!person) throw bad("Employee not found", 404);
    if (String(person.status ?? "").toLowerCase() !== "active") throw bad("Only an active employee can be given a loan or advance", 409);
    const waiting = await db.loan.findFirst({ where: { tenantId, employeeId: person.id, kind, status: "PENDING" }, select: { id: true } });
    if (waiting) throw bad(`This employee already has a ${kind === "ADVANCE" ? "salary advance" : "loan"} request waiting for approval`, 409);
    return { disbursed, reason: why };
}

/**
 * Create a new loan for an employee.
 * Automatically calculates monthly installment from principal, interest, tenure.
 */
export const createLoan = async ({ employeeId, principalMinor, interestRatePct = 0, tenureMonths, disbursementDate, reason, createdById, tenantId, kind = "LOAN", submit = false }) => {
    if (!employeeId) throw bad("employeeId is required");
    const checked = await tenantTransaction(prisma, (tx) => checkLoanInput(tx, { tenantId, employeeId, principalMinor, interestRatePct, tenureMonths, disbursementDate, kind, reason }), { tenantId });
    reason = checked.reason;
    disbursementDate = checked.disbursed;

    // Calculate monthly installment (simple amortization)
    const totalInterest = Math.round(principalMinor * (interestRatePct / 100) * (tenureMonths / 12));
    const totalRepayable = principalMinor + totalInterest;
    const monthlyInstallmentMinor = Math.ceil(totalRepayable / tenureMonths);

    const loan = await prisma.loan.create({
        data: scopedData(tenantId, {
            employeeId: Number(employeeId),
            principalMinor,
            interestRatePct: interestRatePct || 0,
            tenureMonths,
            disbursementDate,
            outstandingMinor: totalRepayable,
            monthlyInstallmentMinor,
            reason,
            createdById: createdById ? Number(createdById) : null,
            kind,
            status: "PENDING",
        }),
    });

    // HR raises the loan for the employee: open its approval request now, filed by HR on the employee's behalf,
    // so a pending loan is never stranded outside the Approval Centre.
    if (submit) await submitOrRemove(loan, tenantId, reason, { onBehalf: true });

    return loan;
};

/** Open the approval request; if it cannot be opened, the request is removed so no orphan stays pending. */
async function submitOrRemove(loan, tenantId, reason, options) {
    try {
        await legacySubmit("LOAN", loan.id, reason, options);
    } catch (error) {
        await prisma.loan.deleteMany({ where: scopedWhere(tenantId, { id: loan.id, status: "PENDING" }) });
        throw error;
    }
}

/**
 * An employee asks for a loan or salary advance for themselves. Interest is for HR to set when raising a loan on
 * someone's behalf; a request from the employee is interest-free. It goes through the same approval route as a loan HR
 * raises, from the employee's own submission.
 */
export const requestMyLoan = async ({ tenantId, employeeId, kind = "LOAN", principalMinor, tenureMonths, disbursementDate, reason }) => {
    if (!tenantId) throw bad("Tenant is required", 403);
    if (!Number.isInteger(Number(employeeId)) || Number(employeeId) < 1) throw bad("Sign in with an employee account to ask for a loan or advance", 403);
    const loan = await createLoan({ tenantId, employeeId, kind, principalMinor, tenureMonths: kind === "ADVANCE" ? 1 : tenureMonths, disbursementDate, reason, createdById: employeeId, interestRatePct: 0, submit: false });
    await submitOrRemove(loan, tenantId, loan.reason, {});
    // A person who holds the final approval (Management) is approved at once, so say what actually happened.
    const after = await prisma.loan.findFirst({ where: scopedWhere(tenantId, { id: loan.id }), select: { status: true } });
    const status = after?.status ?? "PENDING";
    return {
        requested: true, loanId: loan.id, kind: loan.kind, status, monthlyInstallmentMinor: loan.monthlyInstallmentMinor,
        message: status === "ACTIVE" ? "Approved at once. It will be taken from your next payslip." : "Sent for approval. You will be told when it is decided.",
    };
};

/** The employee's own loans and advances, with what they still owe and what has been taken from pay. */
export const listMyLoans = async ({ tenantId, employeeId }) => {
    const items = await prisma.loan.findMany({
        where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
        include: { repayments: { where: { settledAt: { not: null } }, orderBy: { deductedAt: "desc" }, take: 24 } },
        orderBy: { created_at: "desc" },
        take: 100,
    });
    return { items };
};

/**
 * List loans with optional filters.
 */
export const listLoans = async ({ employeeId, status, kind, page = 1, limit = 20, tenantId } = {}) => {
    const where = { ...scopedWhere(tenantId, {}) };
    if (employeeId) where.employeeId = Number(employeeId);
    if (status) where.status = status;
    // HR-PAYROLL-ADVANCE-01 — omitted means "both", so existing callers keep the
    // full list they have always had.
    if (kind) {
        if (!LOAN_KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of ${LOAN_KINDS.join(", ")}`), { status: 400 });
        where.kind = kind;
    }

    const [items, total] = await Promise.all([
        prisma.loan.findMany({
            where,
            include: { repayments: { orderBy: { deductedAt: "desc" }, take: 5 } },
            orderBy: { created_at: "desc" },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.loan.count({ where }),
    ]);

    // People are shown by name, position and department, never by the numeric id.
    const people = await identitiesById(prisma, tenantId, items.map((l) => l.employeeId));
    const named = items.map((l) => ({ ...l, employee: people.get(l.employeeId) ?? null }));

    return { items: named, total, page, limit, totalPages: Math.ceil(total / limit) };
};

/**
 * Get a single loan with repayments.
 */
export const getLoan = async (id, tenantId) => {
    const loan = await prisma.loan.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: { repayments: { orderBy: { deductedAt: "desc" } } },
    });
    if (!loan) return loan;
    const people = await identitiesById(prisma, tenantId, [loan.employeeId]);
    return { ...loan, employee: people.get(loan.employeeId) ?? null };
};

/**
 * Record a manual repayment. Payroll reservations post during finalization.
 */
export const recordRepayment = async ({ loanId, amountMinor, payrollRunId, payslipId, tenantId }) => {
    if(!Number.isSafeInteger(amountMinor) || amountMinor<=0) throw Object.assign(new Error('Repayment must be a positive integer in minor currency units'),{status:400});
    if(payrollRunId || payslipId) throw Object.assign(new Error('Payroll repayments must be posted through payroll finalization'),{status:409});
    return tenantTransaction(prisma,async tx=>{
    await lockAttendancePeriod(tx,tenantId,true);
    const loan = await tx.loan.findFirst({
        where: scopedWhere(tenantId, { id: Number(loanId), status: "ACTIVE" }),
    });
    if (!loan) throw Object.assign(new Error("Active loan not found"), { status: 404 });
    await assertNoPayrollLoanReservation(tx,tenantId,loan.id);
    if(amountMinor>loan.outstandingMinor) throw Object.assign(new Error('Repayment exceeds the outstanding balance'),{status:409});

    const newOutstanding = loan.outstandingMinor - amountMinor;
    const newStatus = newOutstanding <= 0 ? "PAID_OFF" : "ACTIVE";

    const repayment = await tx.loanRepayment.create({
            data: scopedData(tenantId, {
                loanId: Number(loanId),
                amountMinor,
                settledAt:new Date(),
                payrollRunId: payrollRunId ? Number(payrollRunId) : null,
                payslipId: payslipId ? Number(payslipId) : null,
            }),
        });
        await tx.loan.update({
            where: { id: Number(loanId) },
            data: {
                outstandingMinor: Math.max(0, newOutstanding),
                status: newStatus,
            },
        });

    return repayment;
    },{tenantId});
};

/**
 * Auto-deduct loan installments during payroll processing.
 * Returns deduction lines to add to the payslip.
 */
export const getActiveLoanDeductions = async (employeeId, tenantId) => {
    const loans = await prisma.loan.findMany({
        where: scopedWhere(tenantId, {
            employeeId: Number(employeeId),
            status: "ACTIVE",
            outstandingMinor: { gt: 0 },
        }),
    });

    return loans.map(loan => ({
        code: "LOAN",
        name: 'Loan repayment',
        amount: Math.min(loan.monthlyInstallmentMinor,loan.outstandingMinor) / 100, // Convert to major units for payslip
        amountMinor: Math.min(loan.monthlyInstallmentMinor,loan.outstandingMinor),
        loanId: loan.id,
        isLoan: true, // Flag for garnishment cap logic
    }));
};

/**
 * Approve a loan.
 */
export const approveLoan = async (id, approvedById, tenantId) => {
  return legacyDecision('LOAN',id);
};

/**
 * Write off a loan (mark as forgiven).
 */
export const writeOffLoan = async (id, tenantId) => {
    return legacyDecision('LOAN_WRITEOFF',id);
};

/**
 * Get loan KPI summary for dashboard.
 * HR-PAYROLL-ADVANCE-01 — every loan-side figure is narrowed to kind LOAN so an
 * advance is never counted as a loan; advances get their own counters instead of
 * disappearing from the tile.
 */
export const getLoanKpis = async (tenantId) => {
    const [activeCount, totalDisbursed, totalOutstanding, paidOffCount, activeAdvances, advancesOutstanding] = await Promise.all([
        prisma.loan.count({ where: scopedWhere(tenantId, { kind: "LOAN", status: "ACTIVE" }) }),
        prisma.loan.aggregate({ where: scopedWhere(tenantId, { kind: "LOAN" }), _sum: { principalMinor: true } }),
        prisma.loan.aggregate({ where: scopedWhere(tenantId, { kind: "LOAN", status: "ACTIVE" }), _sum: { outstandingMinor: true } }),
        prisma.loan.count({ where: scopedWhere(tenantId, { kind: "LOAN", status: "PAID_OFF" }) }),
        prisma.loan.count({ where: scopedWhere(tenantId, { kind: "ADVANCE", status: "ACTIVE" }) }),
        prisma.loan.aggregate({ where: scopedWhere(tenantId, { kind: "ADVANCE", status: "ACTIVE" }), _sum: { outstandingMinor: true } }),
    ]);

    return {
        activeLoans: activeCount,
        totalDisbursed: (totalDisbursed._sum.principalMinor || 0) / 100,
        totalOutstanding: (totalOutstanding._sum.outstandingMinor || 0) / 100,
        paidOffLoans: paidOffCount,
        activeAdvances,
        advancesOutstanding: (advancesOutstanding._sum.outstandingMinor || 0) / 100,
    };
};
