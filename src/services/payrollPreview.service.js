// Payroll Setup — "Test on a payslip" in-memory preview.
//
// Computes a full payslip for ONE employee from the current/DRAFT payroll config
// WITHOUT persisting anything. Pure compute: reads only, no writes, no outbox.
//
// Order of computation (documented contract):
//   BASE(BASIC) → EARNINGS → GROSS → taxableIncome → TAX(FBR slab) →
//   DEDUCTIONS (+ LWP recovery + income TAX line) → proration/garnishment rules → NET
//
// Fail-soft: an individual SalaryComponent formula error is collected in
// `errors[]` (that one line is skipped) rather than aborting the whole preview.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import { evaluateFormula } from "../lib/payrollFormula.js";

/** Round a money amount to 2 decimal places (half-up on the JS float). */
function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Compute a non-persisting payslip preview for one employee from the current
 * (possibly DRAFT) payroll config.
 *
 * @param {object}  args
 * @param {string|null|undefined} args.tenantId
 * @param {number}  args.employeeId
 * @param {number} [args.daysWorked]   default = workingDays
 * @param {number} [args.workingDays]  default 26
 * @param {number} [args.lwpDays]      default 0
 * @returns {Promise<object>} preview payload (see bottom of function)
 */
export async function previewPayslip({ tenantId, employeeId, daysWorked, workingDays, lwpDays }) {
    const warnings = [];
    const errors = [];
    const appliedRules = [];

    // ── Inputs / defaults ────────────────────────────────────────────────────
    const workDays = Number.isFinite(Number(workingDays)) && Number(workingDays) > 0 ? Number(workingDays) : 26;
    const worked = Number.isFinite(Number(daysWorked)) ? Number(daysWorked) : workDays;
    const lwp = Number.isFinite(Number(lwpDays)) && Number(lwpDays) > 0 ? Number(lwpDays) : 0;

    // ── 1. Employee (scoped; 404 if missing) ─────────────────────────────────
    const employee = await prisma.employee.findFirst({
        where: scopedEmployeeWhere(tenantId, { id: employeeId }),
        select: {
            id: true,
            first_name: true,
            last_name: true,
            employee_name: true,
            gradeLevelId: true,
        },
    });
    if (!employee) {
        throw Object.assign(new Error(`Employee ${employeeId} not found`), { status: 404, code: "HR-PAYPREVIEW-404" });
    }
    const name =
        employee.employee_name ||
        [employee.first_name, employee.last_name].filter(Boolean).join(" ").trim() ||
        `Employee ${employee.id}`;

    // ── 1b. Latest EmploymentTerms → BASE (BASIC) ────────────────────────────
    // baseSalary is a C4-encrypted envelope decrypted to a Number on read by the
    // prisma extension, so Number(...) yields the plaintext monthly base.
    const terms = await prisma.employmentTerms.findFirst({
        where: scopedWhere(tenantId, { employeeId }),
        orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
        select: { id: true, baseSalary: true },
    });

    let BASIC = 0;
    if (terms && terms.baseSalary != null && Number.isFinite(Number(terms.baseSalary))) {
        BASIC = round2(Number(terms.baseSalary));
    } else {
        // Fall back to the employee's grade band midSalary.
        let banded = false;
        if (employee.gradeLevelId != null) {
            const grade = await prisma.gradeLevel.findFirst({
                where: scopedWhere(tenantId, { id: employee.gradeLevelId }),
                select: { midSalary: true },
            });
            if (grade && grade.midSalary != null && Number.isFinite(Number(grade.midSalary))) {
                BASIC = round2(Number(grade.midSalary));
                banded = true;
                warnings.push("No EmploymentTerms base salary; used grade band midSalary as BASIC.");
            }
        }
        if (!banded) {
            BASIC = 0;
            warnings.push("No base salary from EmploymentTerms or grade band; BASIC defaulted to 0.");
        }
    }

    // ── 3. Evaluation scope (all numbers) ────────────────────────────────────
    const scope = {
        BASIC,
        GROSS: 0,
        NET: 0,
        DAYS_WORKED: worked,
        WORKING_DAYS: workDays,
        LWP_DAYS: lwp,
    };

    // ── 4. Active salary components (scoped, ordered) ────────────────────────
    const components = await prisma.salaryComponent.findMany({
        where: scopedWhere(tenantId, { active: true }),
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: {
            code: true,
            name: true,
            type: true,
            computation: true,
            value: true,
            formula: true,
            taxable: true,
        },
    });
    const earningComponents = components.filter((c) => c.type === "EARNING");
    const deductionComponents = components.filter((c) => c.type === "DEDUCTION");

    // Compute a single component's amount by its computation type. Returns null
    // (and records into errors[]) on a formula failure so the caller skips it.
    const computeAmount = (c) => {
        try {
            if (c.computation === "FORMULA") {
                if (!c.formula) throw new Error("FORMULA component missing formula");
                return round2(evaluateFormula(c.formula, scope));
            }
            if (c.computation === "PERCENTAGE") {
                return round2((Number(c.value) || 0) / 100 * BASIC);
            }
            // FIXED (default)
            return round2(Number(c.value) || 0);
        } catch (err) {
            errors.push({ code: c.code, error: err.message });
            return null;
        }
    };

    // ── 5. Earnings first (so GROSS is known before deductions) ──────────────
    const earnings = [];
    let earningsSum = 0;
    for (const c of earningComponents) {
        const amount = computeAmount(c);
        if (amount == null) continue; // formula error already recorded
        earnings.push({ code: c.code, name: c.name, amount, taxable: !!c.taxable });
        earningsSum = round2(earningsSum + amount);
        scope[String(c.code).toUpperCase()] = amount; // later components may reference it
    }
    let GROSS = round2(BASIC + earningsSum);
    scope.GROSS = GROSS;

    // ── 9. Mid-month joiner proration (before tax so the tax base is prorated) ─
    // v1 choice: apply the factor to earning line amounts, then recompute GROSS
    // and the taxable base. BASIC is treated as an earning subject to proration.
    let prorationFactor = 1;
    if (worked < workDays) {
        prorationFactor = round2(worked / workDays);
        // Only prorate when the rule is enabled; otherwise leave lines untouched.
    }

    // ── 6. Taxable income (computed after any proration below) ────────────────
    // Placeholder; real value assigned once proration is resolved.
    let taxableIncome = 0;
    let proratedBasic = BASIC;

    // ── Pay rules config (single row per tenant) ─────────────────────────────
    const payRules =
        (await prisma.payrollRuleConfig.findFirst({
            where: scopedWhere(tenantId, {}),
            orderBy: [{ id: "desc" }],
            select: {
                lwpRecovery: true,
                midMonthJoinerProration: true,
                garnishmentRecovery: true,
                garnishmentCapPct: true,
            },
        })) || {};

    if (payRules.midMonthJoinerProration && worked < workDays) {
        // Apply proration factor to BASIC + each earning line, recompute GROSS.
        proratedBasic = round2(BASIC * prorationFactor);
        for (const e of earnings) {
            e.amount = round2(e.amount * prorationFactor);
            scope[String(e.code).toUpperCase()] = e.amount;
        }
        earningsSum = round2(earnings.reduce((s, e) => s + e.amount, 0));
        GROSS = round2(proratedBasic + earningsSum);
        scope.GROSS = GROSS;
        scope.BASIC = proratedBasic; // downstream deductions see prorated basic
        appliedRules.push(
            `Mid-month joiner proration applied: factor ${prorationFactor} (${worked}/${workDays} days).`,
        );
    }

    // taxableIncome = base (assumed taxable) + earnings flagged taxable.
    taxableIncome = round2(
        proratedBasic + earnings.filter((e) => e.taxable).reduce((s, e) => s + e.amount, 0),
    );

    // ── 7. Tax (FBR slab) ────────────────────────────────────────────────────
    const now = new Date();
    const taxRows = await prisma.taxRate.findMany({
        where: scopedWhere(tenantId, {
            status: "ACTIVE",
            effectiveFrom: { lte: now },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        }),
        orderBy: [{ bracketMin: "asc" }],
        select: { bracketMin: true, bracketMax: true, baseTax: true, rate: true },
    });
    // Highest matching slab: bracketMin ≤ taxableIncome AND (bracketMax null OR ≤).
    let matchedSlab = null;
    for (const s of taxRows) {
        const min = Number(s.bracketMin);
        const max = s.bracketMax == null ? null : Number(s.bracketMax);
        if (min <= taxableIncome && (max == null || taxableIncome <= max)) {
            if (matchedSlab == null || min >= Number(matchedSlab.bracketMin)) matchedSlab = s;
        }
    }
    let taxAmount = 0;
    let slabOut = null;
    if (matchedSlab) {
        const min = Number(matchedSlab.bracketMin);
        taxAmount = round2(Number(matchedSlab.baseTax) + (taxableIncome - min) * Number(matchedSlab.rate));
        if (taxAmount < 0) taxAmount = 0;
        slabOut = {
            from: min,
            upto: matchedSlab.bracketMax == null ? null : Number(matchedSlab.bracketMax),
            baseTax: Number(matchedSlab.baseTax),
            rate: Number(matchedSlab.rate),
        };
    }

    // ── 8. Deductions ────────────────────────────────────────────────────────
    // NOTE(v1): NET is still 0 in scope while deductions are computed, so any
    // deduction FORMULA that references NET sees pre-net 0. Acceptable for v1.
    const deductions = [];
    for (const c of deductionComponents) {
        const amount = computeAmount(c);
        if (amount == null) continue;
        deductions.push({ code: c.code, name: c.name, amount });
        scope[String(c.code).toUpperCase()] = amount;
    }

    // LWP recovery: basic ÷ working days × LWP days.
    if (payRules.lwpRecovery && lwp > 0) {
        const lwpAmount = round2((proratedBasic / workDays) * lwp);
        deductions.push({ code: "LWP", name: "Leave Without Pay Recovery", amount: lwpAmount });
        appliedRules.push(`LWP recovery applied: ${lwp} day(s) → ${lwpAmount}.`);
    }

    // ── 10. Garnishment cap (on loan/garnishment/advance deduction lines) ────
    if (payRules.garnishmentRecovery) {
        const capPct = Number.isFinite(Number(payRules.garnishmentCapPct)) ? Number(payRules.garnishmentCapPct) : 33;
        const isGarnish = (d) => {
            const s = `${d.code || ""} ${d.name || ""}`.toLowerCase();
            return s.includes("loan") || s.includes("garnish") || s.includes("advance");
        };
        // Provisional net = gross minus tax minus all current deduction lines.
        const provisionalDeductions = round2(deductions.reduce((s, d) => s + d.amount, 0) + taxAmount);
        const provisionalNet = round2(GROSS - provisionalDeductions);
        const garnishLines = deductions.filter(isGarnish);
        const garnishTotal = round2(garnishLines.reduce((s, d) => s + d.amount, 0));
        const cap = round2((capPct / 100) * provisionalNet);
        if (garnishTotal > cap && garnishTotal > 0 && cap >= 0) {
            // Scale each garnishment line down proportionally to fit the cap.
            const factor = cap / garnishTotal;
            for (const d of garnishLines) d.amount = round2(d.amount * factor);
            const rollover = round2(garnishTotal - cap);
            appliedRules.push(
                `Garnishment cap applied: recoveries capped at ${capPct}% of net (${cap}); ${rollover} rolled forward.`,
            );
        }
    }

    // Income tax as a deduction line.
    deductions.push({ code: "TAX", name: "Income Tax", amount: taxAmount });

    // ── 11. Totals ───────────────────────────────────────────────────────────
    const totalDeductions = round2(deductions.reduce((s, d) => s + d.amount, 0));
    const net = round2(GROSS - totalDeductions);

    logger.info(
        { employeeId, tenantId, gross: GROSS, net, errors: errors.length },
        "payroll preview computed",
    );

    return {
        employee: { id: employee.id, name },
        inputs: { workingDays: workDays, daysWorked: worked, lwpDays: lwp },
        base: proratedBasic,
        earnings,
        gross: GROSS,
        taxableIncome,
        tax: { amount: taxAmount, slab: slabOut },
        deductions,
        totalDeductions,
        net,
        appliedRules,
        errors,
        warnings,
    };
}
