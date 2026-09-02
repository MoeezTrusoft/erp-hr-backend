// src/services/loan.service.js — Loan & salary advance management
import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

/** HR-PAYROLL-ADVANCE-01 — mirrors the Prisma `LoanKind` enum. */
export const LOAN_KINDS = ["LOAN", "ADVANCE"];

/**
 * Create a new loan for an employee.
 * Automatically calculates monthly installment from principal, interest, tenure.
 */
export const createLoan = async ({ employeeId, principalMinor, interestRatePct = 0, tenureMonths, disbursementDate, reason, createdById, tenantId, kind = "LOAN" }) => {
    if (!employeeId) throw Object.assign(new Error("employeeId is required"), { status: 400 });
    if (!principalMinor || principalMinor <= 0) throw Object.assign(new Error("principalMinor must be positive"), { status: 400 });
    if (!tenureMonths || tenureMonths <= 0) throw Object.assign(new Error("tenureMonths must be positive"), { status: 400 });
    // HR-PAYROLL-ADVANCE-01 — the discriminator is a money-path input; a typo'd
    // value must not reach the column, and an "interest-bearing advance" is a
    // loan mislabelled.
    if (!LOAN_KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of ${LOAN_KINDS.join(", ")}`), { status: 400 });
    if (kind === "ADVANCE" && Number(interestRatePct) > 0) throw Object.assign(new Error("A salary advance cannot carry interest"), { status: 400 });

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
            disbursementDate: disbursementDate ? new Date(disbursementDate) : new Date(),
            outstandingMinor: totalRepayable,
            monthlyInstallmentMinor,
            reason: reason || null,
            createdById: createdById ? Number(createdById) : null,
            kind,
            status: "ACTIVE",
        }),
    });

    return loan;
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

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
};

/**
 * Get a single loan with repayments.
 */
export const getLoan = async (id, tenantId) => {
    return prisma.loan.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: { repayments: { orderBy: { deductedAt: "desc" } } },
    });
};

/**
 * Record a repayment (auto-called during payroll processing).
 */
export const recordRepayment = async ({ loanId, amountMinor, payrollRunId, payslipId, tenantId }) => {
    const loan = await prisma.loan.findFirst({
        where: scopedWhere(tenantId, { id: Number(loanId), status: "ACTIVE" }),
    });
    if (!loan) throw Object.assign(new Error("Active loan not found"), { status: 404 });

    const newOutstanding = loan.outstandingMinor - amountMinor;
    const newStatus = newOutstanding <= 0 ? "PAID_OFF" : "ACTIVE";

    const [repayment] = await prisma.$transaction([
        prisma.loanRepayment.create({
            data: scopedData(tenantId, {
                loanId: Number(loanId),
                amountMinor,
                payrollRunId: payrollRunId ? Number(payrollRunId) : null,
                payslipId: payslipId ? Number(payslipId) : null,
            }),
        }),
        prisma.loan.update({
            where: { id: Number(loanId) },
            data: {
                outstandingMinor: Math.max(0, newOutstanding),
                status: newStatus,
            },
        }),
    ]);

    return repayment;
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
        name: `Loan Repayment (ID:${loan.id})`,
        amount: loan.monthlyInstallmentMinor / 100, // Convert to major units for payslip
        amountMinor: loan.monthlyInstallmentMinor,
        loanId: loan.id,
        isLoan: true, // Flag for garnishment cap logic
    }));
};

/**
 * Approve a loan.
 */
export const approveLoan = async (id, approvedById, tenantId) => {
    const loan = await prisma.loan.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
    });
    if (!loan) throw Object.assign(new Error("Loan not found"), { status: 404 });
    if (loan.status !== "ACTIVE") throw Object.assign(new Error("Loan is not active"), { status: 400 });

    return prisma.loan.update({
        where: { id: Number(id) },
        data: { approvedById: Number(approvedById) },
    });
};

/**
 * Write off a loan (mark as forgiven).
 */
export const writeOffLoan = async (id, tenantId) => {
    const loan = await prisma.loan.findFirst({
        where: scopedWhere(tenantId, { id: Number(id), status: "ACTIVE" }),
    });
    if (!loan) throw Object.assign(new Error("Active loan not found"), { status: 404 });

    return prisma.loan.update({
        where: { id: Number(id) },
        data: { status: "WRITTEN_OFF", outstandingMinor: 0 },
    });
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
