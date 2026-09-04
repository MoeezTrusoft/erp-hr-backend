import { createHash } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { logAction } from "../utils/logs.js";
import { redactC4 } from "../lib/c4Redaction.js";
import * as money from "../lib/money.js";
import { withTenant } from "../lib/tenancy.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { payrollRunFinalizedEvent } from "./hrEvents.js";
import { assertIfMatch } from "../lib/optimisticConcurrency.js";
import { countViolationDays, computeAttendanceDeductions } from "../lib/attendanceDeduction.js";

// HR-ATT-PAYROLL-BRIDGE-01 / HR-PAYROLL-DEDUCTION-TYPE-01 — EVERY deduction the
// engine emits without a tenant-configured type carries a stable CODE, and the
// persistence step resolves that code to a PayrollDeductionType of its own.
//
// There used to be a `?? incomeTaxDeductionTypeId` catch-all at the write, so a
// benefit contribution, a loan instalment, unpaid-leave recovery and every
// statutory contribution (EOBI, both halves of FICA, NI, EPF, ESI) were all
// FILED AS INCOME TAX WITHHELD. The payslip text was right; every aggregate by
// deduction type — and the year-end tax forms in taxFormService.js, which bucket
// withholding by TYPE — were wrong. EOBI and FICA are separate statutory
// obligations and deliberately do not share a type.
//
// The map is the whole registry: a line whose code is not in here cannot be
// persisted, and that is on purpose (see resolveDeductionTypeId below).
const DEDUCTION_TYPE_NAMES = {
    ATTENDANCE_DEDUCTION: 'Attendance Deduction',
    BENEFIT_CONTRIBUTION: 'Benefit Contribution',
    LOAN_REPAYMENT: 'Loan Repayment',
    LWP_RECOVERY: 'Unpaid Leave (LWP) Recovery',
    EOBI_EMPLOYEE: 'EOBI (Employee)',
    FICA_SOCIAL_SECURITY: 'Social Security (FICA)',
    FICA_MEDICARE: 'Medicare (FICA)',
    NATIONAL_INSURANCE: 'National Insurance (NI)',
    EPF: 'EPF (Employee Provident Fund)',
    ESI: 'ESI (Employee State Insurance)',
    INCOME_TAX: 'Income Tax',
};

// HR-PAYROLL-EOBI-01 — defaults used only when a tenant has ENABLED EOBI and
// has not overridden them. PKR 17,000 in minor units (paisa) is the ceiling the
// original comment named; 1% is the employee share. Both are configuration
// because neither has been confirmed against a filed return yet.
const EOBI_DEFAULT_CEILING_MINOR = 1700000;
const EOBI_DEFAULT_EMPLOYEE_RATE_PCT = 1;

// HR-02 / HR-07 (T-P4.1) — DETERMINISTIC, VERSIONED, APPROVAL-GATED payroll.
//
// The legacy engine was non-conformant on three axes:
//   * Tax was HARDCODED (grossAmount*0.15 / *0.05), ignoring the TaxRate table.
//   * All money was JS Float (`grossAmount += amount`, `baseSalary / 2`,
//     `* 12 / 52`) → cent-level rounding non-determinism.
//   * FINALIZE checked only status==='COMPLETED' — no human approval, no
//     separation of the processor from the approver.
//
// This module now:
//   1. Reads tax rates from the VERSIONED TaxRate snapshot effective for the
//      run's period + country (see selectEffectiveTaxRates), records the
//      ruleVersion / ratesEffectiveAt on the run + each payslip so a run is
//      reproducible against the rates that were in effect.
//   2. Does ALL arithmetic in BigInt INTEGER MINOR UNITS via src/lib/money.js
//      (half-even), converting to exact decimal strings only at the Prisma
//      boundary. calculatePeriodSalaryMinor's /2 and *12/52 are exact.
//   3. Requires a human approver DISTINCT from the processor before FINALIZE
//      (approvePayrollRun records approvedBy != processedBy; finalize blocks
//      without it and rejects self-approval).
//   4. Processing is idempotent — re-processing a run reuses existing payslips
//      (the [payrollRunId, employeeId] unique constraint) instead of doubling.
//
// The pure engine helpers (selectEffectiveTaxRates, computeProgressiveTaxMinor,
// computeRuleVersion, calculatePeriodSalaryMinor, buildPayslipFromInputs) are
// EXPORTED so the golden-file regression test drives the REAL engine — no mock
// copy of the logic (the deleted tests/unit/payrollCalculations.test.js
// anti-pattern).

// HR-04 / T-P2.2 — tenant-scope the payroll (C4) surface.
//
// The verified tenant arrives on req.user.tenantId (set by internalServiceGuard
// from the verified service-JWT claim — T-P2.1). The controllers thread that
// value into every service call as `tenantId`; NEVER from req.headers /
// x-tenant-id. Every payroll read/write below carries a tenantId predicate so
// tenant B can never read or mutate tenant A's salaries, payslips, bank/tax
// rows. A cross-tenant single-read resolves to null/not-found (the controller
// maps that to 404), never another tenant's data.
//
// `withTenant` folds the tenant predicate into a where-clause. Interactive
// requests are rejected at the F-06 boundary unless tenantId is a UUID. Direct
// null predicates remain only for explicit migration/backfill callers while
// nullable legacy rows are being reconciled.

// Coerce an actor id (header string / number) to an Int or null. Used to stamp
// processedBy / approvedBy so the separation-of-duties check compares integers.
const toInt = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// HR-02 / HR-07 — PURE, DETERMINISTIC ENGINE CORE (exported; no DB, no I/O)
//
// These functions are the testable heart of the payroll engine. They take plain
// inputs (employment term, assignments, the run, the tax-rate rows) and return
// exact, reproducible results in integer minor units / major-unit Numbers.
// ─────────────────────────────────────────────────────────────────────────────

// Annual→period rational factors. Bi-weekly/weekly approximate the year as
// 12 months; the math is done once, exactly (scaleRational), not as repeated
// float multiplication. Semi-monthly is an exact halving via allocateEvenly so
// the two halves reconstitute the monthly figure to the cent.
const PERIOD_FACTORS = {
    // payFrequency: { num, den } applied to the MONTHLY minor amount.
    BI_WEEKLY: { num: 12, den: 26 }, // 26 bi-weekly periods per year, 12 months
    WEEKLY: { num: 12, den: 52 },
};

/**
 * Period base salary in INTEGER MINOR UNITS. `employmentTerm.baseSalary` is the
 * (decrypted) monthly major-unit Number; we convert to minor units once, then
 * scale deterministically. SEMI_MONTHLY is the first half of an exact even
 * 2-way split so half*2 === monthly (no half-cent drift).
 */
/**
 * Calculate the proration factor for an employee based on hire/termination
 * dates relative to the payroll period. Returns a value between 0 and 1.
 *   1.0 = employee active for the full period
 *   0.5 = employee started mid-period (half month)
 *   0.0 = employee not active during this period at all
 *
 * @param {Date|string} periodStart
 * @param {Date|string} periodEnd
 * @param {Date|string|null} hireDate
 * @param {Date|string|null} termDate - termination date, null if still active
 */
export const computeProrationFactor = (periodStart, periodEnd, hireDateOrPeriods, termDate) => {
    const DAY = 86_400_000;
    // Compare whole days in UTC. Period ends are stored at 23:59:59.999, and
    // differencing raw timestamps makes a 31-day month measure 30.9999 days.
    const dayOf = (v) => {
        const d = new Date(v);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    };
    const pStart = dayOf(periodStart);
    const pEnd = dayOf(periodEnd);
    // Malformed period: pay in full. The previous `1n` was not 100% on the 1e6
    // scale, it was one ten-thousandth of one percent of the salary.
    if (pEnd < pStart) return 1_000_000n;

    const totalDays = Math.max(1, Math.round((pEnd - pStart) / DAY) + 1);

    // HR-PAYROLL-EMPLOYMENT-PERIOD-01 — the third argument is either a list of
    // employment periods or, for callers not yet migrated, a bare hire date.
    // The two-date form is kept because it still prorates mid-month joiners
    // correctly; only the leaver half of it was ever broken, and that half read
    // `employee.term_date`, a column that does not exist.
    const periods = Array.isArray(hireDateOrPeriods)
        ? hireDateOrPeriods
        : [{ startDate: hireDateOrPeriods ?? null, endDate: termDate ?? null }];

    // No employment history on file: pay normally. Backfill must not be able to
    // silently zero somebody's salary by not having run yet.
    if (!periods.length) return 1_000_000n;

    // Clip each period to the run, then MERGE before counting. Two overlapping
    // rows are bad data, not two salaries — summing them blind would pay 200%.
    const spans = [];
    for (const p of periods) {
        if (!p) continue;
        const s = p.startDate ? Math.max(pStart, dayOf(p.startDate)) : pStart;
        const e = p.endDate ? Math.min(pEnd, dayOf(p.endDate)) : pEnd;
        if (e >= s) spans.push([s, e]);
    }
    if (!spans.length) return 0n; // employed at no point during this run

    spans.sort((a, b) => a[0] - b[0]);
    const merged = [spans[0]];
    for (const [s, e] of spans.slice(1)) {
        const last = merged[merged.length - 1];
        // Adjacent days (gap of exactly one day) are contiguous employment, not
        // two spells, so they merge too.
        if (s <= last[1] + DAY) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
    }

    const activeDays = merged.reduce((n, [s, e]) => n + Math.round((e - s) / DAY) + 1, 0);
    if (activeDays >= totalDays) return 1_000_000n;
    return BigInt(Math.round((activeDays / totalDays) * 1_000_000)); // scale 1e6
};

/**
 * Apply proration to a minor-unit amount. `factor` is in scale 1e6 (1_000_000 = 100%).
 */
const applyProration = (amountMinor, factor) => {
    if (factor >= 1_000_000n) return amountMinor;
    return (amountMinor * factor) / 1_000_000n;
};

export const calculatePeriodSalaryMinor = (employmentTerm, payrollRun) => {
    const currency = employmentTerm.currency || payrollRun?.currencyCode || 'USD';
    const monthlyMinor = money.decimalToMinor(employmentTerm.baseSalary, currency);
    switch (employmentTerm.payFrequency) {
        case 'MONTHLY':
            return monthlyMinor;
        case 'SEMI_MONTHLY':
            return money.allocateEvenly(monthlyMinor, 2)[0];
        case 'BI_WEEKLY':
            return money.scaleRational(monthlyMinor, PERIOD_FACTORS.BI_WEEKLY.num, PERIOD_FACTORS.BI_WEEKLY.den);
        case 'WEEKLY':
            return money.scaleRational(monthlyMinor, PERIOD_FACTORS.WEEKLY.num, PERIOD_FACTORS.WEEKLY.den);
        default:
            return monthlyMinor;
    }
};

/**
 * Select the TaxRate rows in effect for a given country at `asOf`, sorted by
 * bracketMin ascending. "Effective" = effectiveFrom <= asOf AND (effectiveTo is
 * null OR effectiveTo >= asOf). This is the versioned snapshot — a future rate
 * row or a foreign-country row is never selected. Pure: does not touch the DB.
 */
export const selectEffectiveTaxRates = (rateRows, { countryCode, asOf }) => {
    const at = asOf instanceof Date ? asOf : new Date(asOf);
    return (rateRows || [])
        .filter((r) => r.countryCode === countryCode)
        .filter((r) => {
            const from = r.effectiveFrom instanceof Date ? r.effectiveFrom : new Date(r.effectiveFrom);
            const to = r.effectiveTo == null ? null : (r.effectiveTo instanceof Date ? r.effectiveTo : new Date(r.effectiveTo));
            return from.getTime() <= at.getTime() && (to === null || to.getTime() >= at.getTime());
        })
        .sort((a, b) => money.compareDecimal(a.bracketMin, b.bracketMin));
};

/**
 * Progressive bracket tax in INTEGER MINOR UNITS. `sortedRows` are the effective
 * rate rows (sorted by bracketMin). Each bracket taxes the slice of gross that
 * falls within [bracketMin, bracketMax) at `rate`; the open-ended top bracket
 * (bracketMax null) taxes the remainder. Bracket bounds are major-unit Numbers
 * (the TaxRate column shape) converted to minor units; the per-bracket multiply
 * rounds half-up once, then the bracket taxes are summed as integers — exact.
 */
export const computeProgressiveTaxMinor = (grossMinor, sortedRows, currency = 'USD') => {
    money.add(grossMinor, 0n); // assert integer minor units
    let taxMinor = 0n;
    for (const row of sortedRows) {
        const lowMinor = money.decimalToMinor(row.bracketMin, currency);
        const highMinor = row.bracketMax == null ? null : money.decimalToMinor(row.bracketMax, currency);
        if (grossMinor <= lowMinor) continue; // gross hasn't reached this bracket
        const upper = highMinor == null || grossMinor < highMinor ? grossMinor : highMinor;
        const sliceMinor = upper - lowMinor;
        if (sliceMinor <= 0n) continue;
        taxMinor = money.add(taxMinor, money.mulRate(sliceMinor, row.rate));
    }
    return taxMinor;
};

/**
 * Deterministic, reproducible rule-version token for a set of effective rate
 * rows + the as-of instant. Same rows + same as-of → same version; ANY rate /
 * bracket / window change yields a different version. A short sha256 over a
 * canonical projection of the rows (id-independent: bracketMin/Max/rate/window)
 * so the version captures the actual computed rule, not row identity.
 */
export const computeRuleVersion = (sortedRows, asOf) => {
    const at = asOf instanceof Date ? asOf : new Date(asOf);
    const canonical = sortedRows.map((r) => ({
        countryCode: r.countryCode,
        bracketMin: String(r.bracketMin),
        bracketMax: r.bracketMax == null ? null : String(r.bracketMax),
        rate: String(r.rate),
        effectiveFrom: new Date(r.effectiveFrom).toISOString(),
        effectiveTo: r.effectiveTo == null ? null : new Date(r.effectiveTo).toISOString(),
    }));
    const payload = JSON.stringify({ asOf: at.toISOString(), rules: canonical });
    return `v1:${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`;
};

/**
 * Compute country-specific statutory deductions (mandatory contributions).
 * Returns an array of deduction line items. Rules are embedded here to keep
 * the engine self-contained — external tax-rate tables handle income tax,
 * while statutory deductions are fixed-per-country with known rates.
 *
 * Supported countries:
 *   PK — EOBI (employer + employee), Social Security (employer-only)
 *   US — FICA (Social Security 6.2% + Medicare 1.45%)
 *   UK — National Insurance (NI) Employee
 *   IN — EPF (Employee Provident Fund 12%) + ESI (1.75%)
 */
const computeStatutoryDeductions = (grossMinor, countryCode, currency = 'USD', ruleConfig = {}) => {
    const lines = [];
    const cc = (countryCode || '').toUpperCase();
    if (grossMinor <= 0n) return lines;

    if (cc === 'PK') {
        // HR-PAYROLL-EOBI-01. This used to be `grossMinor / 100n` under a comment
        // claiming a PKR 17,000 ceiling that was never implemented — so a
        // PKR 200,000 salary was charged PKR 2,000 a month instead of PKR 170.
        // EOBI is assessed on a statutory wage base, so the contribution stops
        // rising once earnings pass the ceiling.
        //
        // OFF unless a tenant enables it. The exact base and rate still need
        // confirming with whoever files the returns, and a plausible-looking
        // default that silently deducts is worse than no line at all.
        if (ruleConfig.eobiEnabled) {
            const ceilingMinor = BigInt(ruleConfig.eobiWageCeilingMinor ?? EOBI_DEFAULT_CEILING_MINOR);
            const ratePct = ruleConfig.eobiEmployeeRatePct ?? EOBI_DEFAULT_EMPLOYEE_RATE_PCT;
            const assessable = grossMinor > ceilingMinor ? ceilingMinor : grossMinor;
            // Scale by 100 before the BigInt so a fractional rate survives.
            const eobiEmployee = (assessable * BigInt(Math.round(ratePct * 100))) / 10000n;
            if (eobiEmployee > 0n) {
                lines.push({
                    deductionTypeId: null,
                    code: 'EOBI_EMPLOYEE',
                    amount: money.minorToDecimal(eobiEmployee, currency),
                    description: 'EOBI (Employee)',
                });
            }
        }
        // Social Security (PESSI/SESSI): employee share is 0% (employer-only),
        // but some companies deduct a nominal amount — include as 0 for transparency.
    } else if (cc === 'US') {
        // Social Security: 6.2% on first $176,100 annualized
        const annualized = grossMinor * 12n;
        const ssCap = money.decimalToMinor('176100', 'USD');
        const taxable = annualized > ssCap ? ssCap / 12n : grossMinor;
        const ss = (taxable * 620n) / 10000n; // 6.2%
        lines.push({
            deductionTypeId: null,
            code: 'FICA_SOCIAL_SECURITY',
            amount: money.minorToDecimal(ss, currency),
            description: 'Social Security (FICA)',
        });
        // Medicare: 1.45% (no cap)
        const medicare = (grossMinor * 145n) / 10000n; // 1.45%
        lines.push({
            deductionTypeId: null,
            code: 'FICA_MEDICARE',
            amount: money.minorToDecimal(medicare, currency),
            description: 'Medicare (FICA)',
        });
    } else if (cc === 'GB') {
        // UK National Insurance (NI) — Class 1 Employee: 8% on £12,570–£50,270
        const annualizedMinor = grossMinor * 12n;
        const lowerEarnings = money.decimalToMinor('12570', 'GBP');
        const upperEarnings = money.decimalToMinor('50270', 'GBP');
        const annualExcess = annualizedMinor > lowerEarnings ? annualizedMinor - lowerEarnings : 0n;
        const annualCap = upperEarnings - lowerEarnings;
        const niable = annualExcess > annualCap ? annualCap : annualExcess;
        const ni = (niable * 8n) / 100n / 12n; // 8% annualized, monthly
        if (ni > 0n) {
            lines.push({
                deductionTypeId: null,
                code: 'NATIONAL_INSURANCE',
                amount: money.minorToDecimal(ni, currency),
                description: 'National Insurance (NI)',
            });
        }
    } else if (cc === 'IN') {
        // EPF: 12% of basic (approximated as gross for simplicity)
        const epf = (grossMinor * 12n) / 100n;
        lines.push({
            deductionTypeId: null,
            code: 'EPF',
            amount: money.minorToDecimal(epf, currency),
            description: 'EPF (Employee Provident Fund)',
        });
        // ESI: 1.75% (applicable if gross < ₹21,000/month)
        const esiCap = money.decimalToMinor('21000', 'INR');
        if (grossMinor < esiCap) {
            const esi = (grossMinor * 175n) / 10000n; // 1.75%
            lines.push({
                deductionTypeId: null,
                code: 'ESI',
                amount: money.minorToDecimal(esi, currency),
                description: 'ESI (Employee State Insurance)',
            });
        }
    }

    return lines;
};

/**
 * Build the canonical payslip object for one employee, PURELY (no DB). All money
 * is computed in integer minor units and emitted as major-unit Numbers at the
 * boundary. Earnings/deductions are produced in a FIXED order so the serialized
 * payslip is byte-stable (the golden-file determinism contract):
 *   earnings:   [ base salary, overtime, employer benefits, then each rate/flat earning assignment ]
 *   deductions: [ employee benefits, loans, LWP, each deduction assignment, then each tax bracket line ]
 *
 * @param {Object} bridges - Auto-populated data from other HR modules
 * @param {Array} bridges.overtimeLines - Approved overtime hours for the period
 * @param {Array} bridges.lwpDays - Unpaid leave days for the period
 * @param {Array} bridges.benefitLines - Active employee benefit contributions
 * @param {Array} bridges.loanLines - Active loan deductions
 * @param {Array} bridges.attendanceDeductionLines - Priced attendance violations
 *        from src/lib/attendanceDeduction.js: { ruleKey, counterGroup,
 *        occurrences, days } (HR-ATT-PAYROLL-BRIDGE-01)
 *
 * @returns {{ employeeId, ruleVersion, ratesEffectiveAt, grossAmount,
 *             totalDeductions, netAmount, earnings:[], deductions:[] }}
 */
export const buildPayslipFromInputs = ({ employee, employmentTerm, assignments = [], payrollRun, taxRateRows = [], asOf, bridges = {}, ruleConfig = {} }) => {
    const at = asOf || payrollRun?.periodEnd;
    const earnings = [];
    const deductions = [];
    const currency = payrollRun.currencyCode || employmentTerm?.currency || 'USD';
    let grossMinor = 0n;
    // HR-PAYROLL-DEDUCTION-BASIS-01 — base + fixed allowances, i.e. the monthly
    // package the employee is contracted for. See step 7 for why this is not
    // grossMinor.
    let contractualMinor = 0n;

    // PRORATION: the share of the run the employee was actually employed for.
    // HR-PAYROLL-EMPLOYMENT-PERIOD-01 — previously this passed
    // `employee.term_date || employee.terminationDate`, and Employee has
    // neither column, so the leaver branch never ran. Employment periods carry
    // the leaving date, and a re-hire is two of them.
    const prorationFactor = computeProrationFactor(
        payrollRun.periodStart,
        payrollRun.periodEnd,
        employee?.employmentPeriods?.length
            ? employee.employmentPeriods
            : (employee?.hire_date || employee?.hireDate),
    );

    // 1) Base salary (if the employee has employment terms), prorated if mid-month start/end.
    if (employmentTerm) {
        let baseMinor = calculatePeriodSalaryMinor(employmentTerm, payrollRun);
        const isProrated = prorationFactor > 0n && prorationFactor < 1_000_000n;
        if (isProrated) {
            baseMinor = applyProration(baseMinor, prorationFactor);
        }
        earnings.push({
            earningTypeId: employmentTerm.baseSalaryEarningTypeId ?? null,
            amount: money.minorToDecimal(baseMinor, currency),
            description: isProrated
                ? `Base salary (prorated ${(Number(prorationFactor) / 10000).toFixed(1)}%) for ${isoDate(payrollRun.periodStart)} to ${isoDate(payrollRun.periodEnd)}`
                : `Base salary for ${isoDate(payrollRun.periodStart)} to ${isoDate(payrollRun.periodEnd)}`,
        });
        grossMinor = money.add(grossMinor, baseMinor);
        // HR-PAYROLL-DEDUCTION-BASIS-01 — the CONTRACTUAL monthly package, which
        // is what a deducted day is charged against. Tracked separately from
        // grossMinor because gross also accumulates overtime and employer
        // benefits, and working overtime must not make a different day of
        // absence cost more.
        contractualMinor = money.add(contractualMinor, baseMinor);
    }

    // 2) BRIDGE: Overtime → Earning (approved OT hours × hourly rate × OT multiplier)
    if (bridges.overtimeLines?.length > 0 && employmentTerm) {
        const monthlyBaseMinor = money.decimalToMinor(employmentTerm.baseSalary || '0', currency);
        const hourlyMinor = monthlyBaseMinor / 176n; // ~22 working days × 8 hours
        for (const ot of bridges.overtimeLines) {
            const otAmountMinor = BigInt(Math.round(ot.hours * Number(hourlyMinor) * (ot.rate || 1.5)));
            if (otAmountMinor > 0n) {
                earnings.push({
                    earningTypeId: null,
                    amount: money.minorToDecimal(otAmountMinor, currency),
                    description: `Overtime (${ot.hours}h × ${ot.rate || 1.5}x) — ${ot.date || ''}`,
                });
                grossMinor = money.add(grossMinor, otAmountMinor);
            }
        }
    }

    // 3) BRIDGE: Employer benefit contributions → Earning
    if (bridges.benefitLines?.length > 0) {
        for (const b of bridges.benefitLines) {
            if (b.employerContributionMinor > 0) {
                const amt = BigInt(b.employerContributionMinor);
                earnings.push({
                    earningTypeId: null,
                    amount: money.minorToDecimal(amt, currency),
                    description: `Employer: ${b.planName || 'Benefit'}`,
                });
                grossMinor = money.add(grossMinor, amt);
            }
        }
    }

    // 4) Assignment-driven earnings & deductions, in declared order. A flat
    //    `amount` is taken verbatim; a `rate` applies to gross-so-far (matching
    //    the legacy semantics) — both in minor units, rounded half-up once.
    for (const assignment of assignments) {
        if (assignment.earningType) {
            const amountMinor = assignment.amount != null
                ? money.decimalToMinor(assignment.amount, currency)
                : money.mulRate(grossMinor, assignment.rate || '0');
            earnings.push({
                earningTypeId: assignment.earningType.id,
                amount: money.minorToDecimal(amountMinor, currency),
                description: assignment.earningType.name,
            });
            grossMinor = money.add(grossMinor, amountMinor);
            // Allowances are part of the contracted package (house, transport,
            // medical, utilities), so they count toward a deducted day.
            contractualMinor = money.add(contractualMinor, amountMinor);
        } else if (assignment.deductionType) {
            const amountMinor = assignment.amount != null
                ? money.decimalToMinor(assignment.amount, currency)
                : money.mulRate(grossMinor, assignment.rate || '0');
            deductions.push({
                deductionTypeId: assignment.deductionType.id,
                amount: money.minorToDecimal(amountMinor, currency),
                description: assignment.deductionType.name,
            });
        }
    }

    // 5) BRIDGE: Employee benefit contributions → Deduction
    if (bridges.benefitLines?.length > 0) {
        for (const b of bridges.benefitLines) {
            if (b.employeeContributionMinor > 0) {
                deductions.push({
                    deductionTypeId: null,
                    code: 'BENEFIT_CONTRIBUTION',
                    amount: money.minorToDecimal(BigInt(b.employeeContributionMinor), currency),
                    description: `Benefit: ${b.planName || 'Plan'}`,
                });
            }
        }
    }

    // 6) BRIDGE: Loan repayments → Deduction (with garnishment cap at 40% of gross)
    if (bridges.loanLines?.length > 0) {
        const grossLimit = grossMinor * 40n / 100n; // 40% garnishment cap
        let loanTotalMinor = 0n;
        for (const loan of bridges.loanLines) {
            const loanMinor = BigInt(loan.amountMinor || 0);
            const cappedMinor = loanTotalMinor + loanMinor > grossLimit
                ? grossLimit - loanTotalMinor
                : loanMinor;
            if (cappedMinor > 0n) {
                deductions.push({
                    deductionTypeId: null,
                    code: 'LOAN_REPAYMENT',
                    amount: money.minorToDecimal(cappedMinor, currency),
                    description: loan.name || 'Loan Repayment',
                    loanId: loan.loanId,
                });
                loanTotalMinor += cappedMinor;
            }
        }
    }

    // 7) BRIDGE: unpaid DAYS → Deduction.
    //
    // HR-ATT-PAYROLL-BRIDGE-01: LWP and attendance deductions are the same
    // concept — "this many days of salary are not owed" — so they share ONE
    // daily rate. Two formulas for one concept is how a payslip ends up with two
    // different answers for the same day.
    //
    // Days may be fractional (a half-day attendance deduction, a half-day LWP),
    // so the multiplier is scaled by 100 before the BigInt. `BigInt(0.5)` threw
    // a RangeError and took the whole payslip build down with it.
    if (employmentTerm && (bridges.lwpDays > 0 || bridges.attendanceDeductionLines?.length > 0)) {
        const baseMinor = money.decimalToMinor(employmentTerm.baseSalary || '0', currency);

        // HR-PAYROLL-DEDUCTION-BASIS-01. Operator spec: a deducted day is the
        // FULL monthly salary divided by the CALENDAR days of the month, not
        // base salary over a fixed 26 working days.
        //
        // The divisor is the period's own length, so August (31) and February
        // (28) differ — a monthly salary buys a month, however long it is.
        // Count CALENDAR DAYS, not elapsed milliseconds. Callers pass periodEnd
        // as 23:59:59.999, and differencing timestamps gives 30.9999 for August
        // — which rounds to 31, then +1 = 32. Every deduction came out ~3%
        // light. Truncate both ends to their UTC date first.
        const dayOf = (d) => {
            const x = new Date(d);
            return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
        };
        const periodDays = Math.max(
            1,
            Math.round((dayOf(payrollRun.periodEnd) - dayOf(payrollRun.periodStart)) / 86_400_000) + 1,
        );

        // GROSS (the default) charges against base + fixed allowances. Salaries
        // here are structured basic 45% + allowances 55%, so BASIC would
        // under-deduct by more than half. An unrecognised value falls back to
        // GROSS deliberately: under-deducting silently is the worse failure.
        const basisMinor =
            ruleConfig.deductionBasis === 'BASIC' ? baseMinor : contractualMinor || baseMinor;

        const daysToMinor = (days) =>
            (basisMinor * BigInt(Math.round(days * 100))) / (100n * BigInt(periodDays));

        if (bridges.lwpDays > 0) {
            const lwpMinor = daysToMinor(bridges.lwpDays);
            if (lwpMinor > 0n) {
                deductions.push({
                    deductionTypeId: null,
                    code: 'LWP_RECOVERY',
                    amount: money.minorToDecimal(lwpMinor, currency),
                    description: `LWP Recovery (${bridges.lwpDays} days)`,
                });
            }
        }

        // 7a) BRIDGE: counted attendance violations → Deduction. The engine that
        //     produced these lines (src/lib/attendanceDeduction.js) has already
        //     applied triggerCount, counterGroup pooling and the per-period cap;
        //     all that is left here is days → money.
        for (const line of bridges.attendanceDeductionLines || []) {
            const days = Number(line?.days) || 0;
            if (days <= 0) continue;
            const amountMinor = daysToMinor(days);
            if (amountMinor <= 0n) continue;
            const label = line.counterGroup || line.ruleKey;
            deductions.push({
                deductionTypeId: null,
                code: 'ATTENDANCE_DEDUCTION',
                amount: money.minorToDecimal(amountMinor, currency),
                description:
                    `Attendance: ${label} (${line.occurrences} occurrence${line.occurrences === 1 ? '' : 's'}` +
                    ` = ${days} day${days === 1 ? '' : 's'})`,
            });
        }
    }

    // 7b) STATUTORY DEDUCTIONS: Country-specific mandatory contributions.
    //     Applied AFTER voluntary deductions but BEFORE income tax so the
    //     statutory amounts reduce the taxable base where applicable.
    const statutoryLines = computeStatutoryDeductions(grossMinor, payrollRun.countryCode, currency, ruleConfig);
    for (const line of statutoryLines) {
        deductions.push(line);
    }

    // 8) Versioned tax: select the effective rows, compute progressive tax in
    //    minor units, record the rule version. One combined tax line keeps the
    //    payslip deterministic and matches the table-driven figure.
    const sorted = selectEffectiveTaxRates(taxRateRows, { countryCode: payrollRun.countryCode, asOf: at });
    const ruleVersion = computeRuleVersion(sorted, at);
    const taxMinor = computeProgressiveTaxMinor(grossMinor, sorted, currency);
    if (taxMinor > 0n || sorted.length > 0) {
        deductions.push({
            deductionTypeId: null,
            code: 'INCOME_TAX',
            amount: money.minorToDecimal(taxMinor, currency),
            description: 'Income Tax',
        });
    }

    const totalDeductionsMinor = money.sum(deductions.map((d) => money.decimalToMinor(d.amount, currency)));
    const netMinor = money.sub(grossMinor, totalDeductionsMinor);

    return {
        employeeId: employee?.id ?? null,
        ruleVersion,
        ratesEffectiveAt: new Date(at).toISOString(),
        grossAmount: money.minorToDecimal(grossMinor, currency),
        totalDeductions: money.minorToDecimal(totalDeductionsMinor, currency),
        netAmount: money.minorToDecimal(netMinor, currency),
        prorationFactor: prorationFactor >= 1_000_000n ? 1.0 : Number(prorationFactor) / 1_000_000,
        earnings,
        deductions,
    };
};

const isoDate = (d) => new Date(d).toISOString().split('T')[0];

// Payroll Run Operations
export const getPayrollRuns = async ({ page, limit, status, tenantId }) => {
    const skip = (page - 1) * limit;
    const where = withTenant(tenantId, status ? { status } : {});

    const [payrollRuns, total] = await Promise.all([
        prisma.payrollRun.findMany({
            where,
            skip,
            take: parseInt(limit),
            orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
            include: {
                payslips: {
                    include: {
                        employee: {
                            select: { id: true, first_name: true, last_name: true }
                        }
                    }
                }
            }
        }),
        prisma.payrollRun.count({ where })
    ]);

    return {
        payrollRuns,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export const getPayrollRunById = async (id, tenantId) => {
    // findFirst (not findUnique) so the read carries the tenant predicate: a
    // cross-tenant id resolves to null → controller returns 404.
    return prisma.payrollRun.findFirst({
        where: withTenant(tenantId, { id }),
        include: {
            payslips: {
                include: {
                    employee: {
                        select: { id: true, first_name: true, last_name: true, job_title: true }
                    },
                    earnings: {
                        include: {
                            earningType: true
                        }
                    },
                    deductions: {
                        include: {
                            deductionType: true
                        }
                    }
                }
            }
        }
    });
};

export const createPayrollRun = async (data, createdBy, tenantId) => {
  const existingRun = await prisma.payrollRun.findFirst({
    where: withTenant(tenantId, {
      OR: [
        {
          periodStart: { lte: data.periodEnd },
          periodEnd: { gte: data.periodStart }
        }
      ]
    })
  });

  if (existingRun) {
    throw new Error('Payroll run already exists for the specified period');
  }

  const exactData = { ...data };
  for (const field of ['totalGross', 'totalDeductions', 'totalNet']) {
    if (exactData[field] != null) exactData[field] = money.decimalToPersistence(exactData[field]);
  }
  const create = await prisma.payrollRun.create({
    data: {
      ...exactData,
      tenantId: tenantId ?? null,
      status: 'PENDING'
    }
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Payroll Run",
    result: "SUCCESS",
    notes: `Payroll run "${create.id}" created successfully`
  });

  return create;
};

// Statuses a run may be (re-)processed FROM. PENDING is the first run; COMPLETED
// and FAILED allow an idempotent re-process (no doubled payslips). PROCESSING is
// allowed so a crashed run can be retried. APPROVED/FINALIZED/CANCELLED are
// terminal-ish and must NOT be silently re-computed.
const PROCESSABLE_STATUSES = new Set(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']);

export const processPayrollRun = async (id, updatedBy, tenantId) => {
    const payrollRun = await prisma.payrollRun.findFirst({
        where: withTenant(tenantId, { id }),
        include: {
            payslips: true
        }
    });

    if (!payrollRun) {
        throw new Error('Payroll run not found');
    }

    if (!PROCESSABLE_STATUSES.has(payrollRun.status)) {
        throw new Error(`Payroll run cannot be processed from ${payrollRun.status} status`);
    }

    // Update status to PROCESSING (scoped: updateMany so the tenant predicate
    // applies — a cross-tenant id would touch zero rows). Stamp processedBy so
    // the approver can be enforced as a DISTINCT employee at finalize time.
    await prisma.payrollRun.updateMany({
        where: withTenant(tenantId, { id }),
        data: { status: 'PROCESSING', processedBy: toInt(updatedBy) }
    });

    try {
        // Get all active employees for this tenant
        const employees = await prisma.employee.findMany({
            // HR-PAYROLL-EMPLOYMENT-PERIOD-01 — `status: 'active'` alone is a
            // cliff for leavers: deactivating someone who left mid-month drops
            // them from the run entirely and they lose the days they DID work.
            // Anyone with an employment period touching this run is included and
            // then prorated to the days it covers.
            where: {
                tenant_id: tenantId ?? null,
                OR: [
                    // Case-insensitive on purpose. 73 of 75 production rows spell
                    // this "Active" and Postgres equality is case-sensitive, so
                    // the plain literal matched exactly ONE employee — payroll
                    // selected almost nobody and reported no error.
                    { status: { equals: 'active', mode: 'insensitive' } },
                    {
                        employmentPeriods: {
                            some: {
                                startDate: { lte: payrollRun.periodEnd },
                                OR: [
                                    { endDate: null },
                                    { endDate: { gte: payrollRun.periodStart } },
                                ],
                            },
                        },
                    },
                ],
            },
            include: {
                // Every spell touching the run. computeProrationFactor clips and
                // merges them, so a re-hire is simply two rows.
                employmentPeriods: {
                    where: {
                        startDate: { lte: payrollRun.periodEnd },
                        OR: [{ endDate: null }, { endDate: { gte: payrollRun.periodStart } }],
                    },
                    select: { startDate: true, endDate: true },
                    orderBy: { startDate: 'asc' },
                },
                employmentTerms: {
                    where: withTenant(tenantId, {
                        effectiveFrom: { lte: payrollRun.periodEnd },
                        OR: [
                            { effectiveTo: null },
                            { effectiveTo: { gte: payrollRun.periodStart } }
                        ]
                    }),
                    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
                    take: 1
                },
                payrollAssignments: {
                    where: withTenant(tenantId, {
                        effectiveFrom: { lte: payrollRun.periodEnd },
                        OR: [
                            { effectiveTo: null },
                            { effectiveTo: { gte: payrollRun.periodStart } }
                        ],
                        isActive: true
                    }),
                    include: {
                        earningType: true,
                        deductionType: true
                    }
                },
                // HR-ATT-PAYROLL-BRIDGE-01 — the daily attendance verdicts and the
                // anomaly decisions that excuse or condemn them. Both are read here,
                // on the query that was already being issued, rather than as a
                // per-employee round trip inside the map below.
                attendance: {
                    where: {
                        date: {
                            gte: payrollRun.periodStart,
                            lte: payrollRun.periodEnd
                        }
                    },
                    select: { date: true, status: true, manually_corrected: true }
                },
                attendanceAnomalies: {
                    where: {
                        date: {
                            gte: payrollRun.periodStart,
                            lte: payrollRun.periodEnd
                        }
                    },
                    select: { date: true, status: true, type: true }
                }
            }
        });

        // HR-ATT-PAYROLL-BRIDGE-01 — the deduction rules are per TENANT, not per
        // employee, so they are read once for the whole run. Ordered by ruleKey so
        // the deduction lines they generate land in a stable order (the golden-file
        // determinism contract).
        //
        // ponytail: the counting window is the RUN's period. A rule configured
        // periodScope 'MONTH' therefore counts over the run period, which is the
        // same thing for the monthly runs this fleet actually executes. Widening it
        // needs a second attendance read — add that when a non-monthly calendar
        // appears.
        const attendanceDeductionRules = await prisma.attendanceDeductionRule.findMany({
            where: withTenant(tenantId, { enabled: true }),
            orderBy: { ruleKey: 'asc' }
        });

        // HR-PAYROLL-EOBI-01 — per-tenant statutory switches, read once for the
        // run. Absent row means the tenant never configured payroll rules, which
        // is the same as everything off.
        const ruleConfig = (await prisma.payrollRuleConfig.findUnique({ where: { tenantId } })) ?? {};

        // HR-02 — read the VERSIONED tax snapshot ONCE for the run's country,
        // effective at the run's period end. selectEffectiveTaxRates ignores
        // future-dated and foreign-country rows; computeRuleVersion records the
        // exact rule the run is computed against so it is reproducible.
        const allCountryRates = await prisma.taxRate.findMany({
            where: withTenant(tenantId, { countryCode: payrollRun.countryCode })
        });
        const ratesEffectiveAt = payrollRun.periodEnd;
        const effectiveRates = selectEffectiveTaxRates(allCountryRates, {
            countryCode: payrollRun.countryCode,
            asOf: ratesEffectiveAt
        });
        const ruleVersion = computeRuleVersion(effectiveRates, ratesEffectiveAt);

        // Resolve the persisted type ids the pure engine leaves null (base
        // salary earning) once per run.
        const baseSalaryEarningTypeId = await getBaseSalaryEarningTypeId(tenantId);

        // HR-PAYROLL-DEDUCTION-TYPE-01 — code → PayrollDeductionType, resolved
        // ONCE per run and LAZILY: a tenant that never emits an EOBI line never
        // gets an EOBI type row. Cache the PROMISE, not the id, so the parallel
        // per-employee map below cannot race two creates for the same code.
        const deductionTypeIds = new Map();
        const resolveDeductionTypeId = (code) => {
            const name = DEDUCTION_TYPE_NAMES[code];
            // No silent fallback. A line reaching persistence with no resolvable
            // type is a bug in whichever bridge emitted it — recording it as
            // income tax is how this finding happened in the first place.
            if (!name) throw new Error(`HR-PAYROLL-DEDUCTION-TYPE-01: deduction line has no resolvable deduction type (code=${code ?? 'none'})`);
            if (!deductionTypeIds.has(code)) {
                deductionTypeIds.set(code, getOrCreateDeductionType(code, name, tenantId));
            }
            return deductionTypeIds.get(code);
        };

        const payslipPromises = employees.map(async (employee) => {
            const employmentTerm = employee.employmentTerms[0]
                ? { ...employee.employmentTerms[0], baseSalaryEarningTypeId }
                : null;
            // HR-PAYROLL-DEDUCTION-TYPE-01 (found while testing the loan bridge):
            // the loan-repayment recording below referenced an UNDECLARED
            // `currency`, so processing ANY employee with an active loan threw
            // `ReferenceError: currency is not defined` and failed the whole run.
            // Same resolution order buildPayslipFromInputs uses, so the amount is
            // converted back with the scale it was emitted in.
            const currency = payrollRun.currencyCode || employmentTerm?.currency || 'USD';

            // ── BRIDGE DATA: Fetch overtime, leave, benefits, loans for this employee ──
            const [overtimeRequests, unpaidLeaves, employeeBenefits, activeLoans] = await Promise.all([
                // Approved overtime requests within the payroll period
                prisma.overtimeRequest.findMany({
                    where: withTenant(tenantId, {
                        employeeId: employee.id,
                        status: "APPROVED",
                        date: { gte: payrollRun.periodStart, lte: payrollRun.periodEnd },
                    }),
                    select: { date: true, hours: true, rate: true },
                }),
                // Unpaid leave (LWP) days within the period
                prisma.leaveRequest.findMany({
                    where: withTenant(tenantId, {
                        employeeId: employee.id,
                        status: "APPROVED",
                        startDate: { lte: payrollRun.periodEnd },
                        endDate: { gte: payrollRun.periodStart },
                    }),
                    select: { totalDays: true, leavePolicy: { select: { leaveTypeCode: true } } },
                }),
                // Active benefit enrollments with plan details
                prisma.employeeBenefit.findMany({
                    where: withTenant(tenantId, {
                        employeeId: employee.id,
                        status: "ACTIVE",
                    }),
                    include: { benefitPlan: { select: { name: true, employerContributionMinor: true, employeeContributionMinor: true } } },
                }),
                // Active loans with outstanding balance
                prisma.loan.findMany({
                    where: withTenant(tenantId, {
                        employeeId: employee.id,
                        status: "ACTIVE",
                        outstandingMinor: { gt: 0 },
                    }),
                    select: { id: true, monthlyInstallmentMinor: true, outstandingMinor: true },
                }),
            ]);

            // Build bridge data
            const bridges = {
                overtimeLines: overtimeRequests.map(ot => ({
                    date: ot.date?.toISOString().split('T')[0],
                    hours: ot.hours,
                    rate: ot.rate,
                })),
                lwpDays: unpaidLeaves
                    .filter(l => l.leavePolicy?.leaveTypeCode === 'UNPAID' || l.leavePolicy?.leaveTypeCode === 'LWP')
                    .reduce((sum, l) => sum + (l.totalDays || 0), 0),
                benefitLines: employeeBenefits.map(eb => ({
                    planName: eb.benefitPlan?.name,
                    employerContributionMinor: eb.benefitPlan?.employerContributionMinor || 0,
                    employeeContributionMinor: eb.electedAmountMinor || eb.benefitPlan?.employeeContributionMinor || 0,
                })),
                loanLines: activeLoans.map(loan => ({
                    loanId: loan.id,
                    name: `Loan Repayment (ID:${loan.id})`,
                    amountMinor: loan.monthlyInstallmentMinor,
                })),
                // HR-ATT-PAYROLL-BRIDGE-01 — counted violations priced into DAYS by
                // the pure engine. Empty when no rule is enabled, which is the
                // shipped state for every tenant until a dry run has been read.
                attendanceDeductionLines: attendanceDeductionRules.length
                    ? computeAttendanceDeductions({
                        violations: countViolationDays({
                            attendance: employee.attendance,
                            anomalies: employee.attendanceAnomalies,
                        }),
                        rules: attendanceDeductionRules,
                    })
                    : [],
            };

            // Build the canonical payslip with the REAL, deterministic engine.
            const built = buildPayslipFromInputs({
                employee,
                employmentTerm,
                assignments: employee.payrollAssignments,
                payrollRun,
                taxRateRows: allCountryRates,
                asOf: ratesEffectiveAt,
                bridges,
                ruleConfig,
            });

            // Map each engine line the tenant did not type itself (everything but
            // an assignment-driven deduction) to the type its CODE resolves to.
            // FORCE-RLS: payroll_earnings / payroll_deductions are tenant-scoped;
            // each nested-created line must carry tenantId (== app.tenant_id) or
            // the WITH CHECK policy rejects the insert.
            const earnings = built.earnings.map((e) => ({
                tenantId: tenantId ?? null,
                earningTypeId: e.earningTypeId ?? baseSalaryEarningTypeId,
                amount: e.amount,
                description: e.description
            }));
            // Promise.all preserves array order — the deduction ORDER is part of
            // the determinism contract and must survive the async resolve.
            const deductions = await Promise.all(built.deductions.map(async (d) => ({
                tenantId: tenantId ?? null,
                deductionTypeId: d.deductionTypeId ?? await resolveDeductionTypeId(d.code),
                amount: d.amount,
                description: d.description
            })));

            // IDEMPOTENCY: a payslip already exists for [payrollRunId, employeeId]
            // (unique constraint) on a re-process. Replace its lines + figures in
            // place instead of inserting a duplicate (the old code's create-in-a-
            // loop doubled payslips on re-run).
            const existing = await prisma.payrollPayslip.findFirst({
                where: withTenant(tenantId, { payrollRunId: id, employeeId: employee.id })
            });

            if (existing) {
                await prisma.payrollEarning.deleteMany({ where: { payslipId: existing.id } });
                await prisma.payrollDeduction.deleteMany({ where: { payslipId: existing.id } });
                const updated = await prisma.payrollPayslip.update({
                    where: { id: existing.id },
                    data: {
                        grossAmount: built.grossAmount,
                        totalDeductions: built.totalDeductions,
                        netAmount: built.netAmount,
                        ruleVersion,
                        status: 'DRAFT',
                        earnings: { create: earnings },
                        deductions: { create: deductions }
                    },
                    include: { earnings: true, deductions: true }
                });
                // Record loan repayments for this payslip
                for (const loan of bridges.loanLines || []) {
                    const loanDeduction = built.deductions.find(d => d.loanId === loan.loanId);
                    if (loanDeduction) {
                        const deductMinor = money.decimalToMinor(loanDeduction.amount, currency);
                        if (deductMinor > 0n) {
                            await prisma.loanRepayment.create({
                                data: {
                                    tenantId: tenantId ?? null,
                                    loanId: loan.loanId,
                                    amountMinor: Number(deductMinor),
                                    payrollRunId: id,
                                    payslipId: updated.id,
                                },
                            });
                            await prisma.loan.update({
                                where: { id: loan.loanId },
                                data: { outstandingMinor: { decrement: Number(deductMinor) } },
                            });
                        }
                    }
                }
                // AUDIT: Log the re-process event for this payslip
                await prisma.payrollAuditLog.create({
                    data: {
                        tenantId: tenantId ?? null,
                        action: 'PAYSLIP_REPROCESSED',
                        details: `Payslip re-processed for employee ${employee.id}`,
                        payrollRunId: id,
                        payslipId: updated.id,
                        employeeId: employee.id,
                        oldValues: { grossAmount: existing.grossAmount, totalDeductions: existing.totalDeductions, netAmount: existing.netAmount },
                        newValues: { grossAmount: built.grossAmount, totalDeductions: built.totalDeductions, netAmount: built.netAmount, prorationFactor: built.prorationFactor },
                    },
                });
                return updated;
            }

            const created = await prisma.payrollPayslip.create({
                data: {
                    tenantId: tenantId ?? null,
                    payrollRunId: id,
                    employeeId: employee.id,
                    grossAmount: built.grossAmount,
                    totalDeductions: built.totalDeductions,
                    netAmount: built.netAmount,
                    ruleVersion,
                    status: 'DRAFT',
                    earnings: { create: earnings },
                    deductions: { create: deductions }
                },
                include: {
                    earnings: true,
                    deductions: true
                }
            });
            // Record loan repayments for this payslip
            for (const loan of bridges.loanLines || []) {
                const loanDeduction = built.deductions.find(d => d.loanId === loan.loanId);
                if (loanDeduction) {
                    const deductMinor = money.decimalToMinor(loanDeduction.amount, currency);
                    if (deductMinor > 0n) {
                        await prisma.loanRepayment.create({
                            data: {
                                tenantId: tenantId ?? null,
                                loanId: loan.loanId,
                                amountMinor: Number(deductMinor),
                                payrollRunId: id,
                                payslipId: created.id,
                            },
                        });
                        await prisma.loan.update({
                            where: { id: loan.loanId },
                            data: { outstandingMinor: { decrement: Number(deductMinor) } },
                        });
                    }
                }
            }
            // AUDIT: Log the initial payslip creation
            await prisma.payrollAuditLog.create({
                data: {
                    tenantId: tenantId ?? null,
                    action: 'PAYSLIP_CREATED',
                    details: `Payslip created for employee ${employee.id}`,
                    payrollRunId: id,
                    payslipId: created.id,
                    employeeId: employee.id,
                    oldValues: null,
                    newValues: {
                        grossAmount: built.grossAmount,
                        totalDeductions: built.totalDeductions,
                        netAmount: built.netAmount,
                        ruleVersion: built.ruleVersion,
                        prorationFactor: built.prorationFactor,
                        earningsCount: earnings.length,
                        deductionsCount: deductions.length,
                    },
                },
            });
            return created;
        });

        const payslips = await Promise.all(payslipPromises);

        // Totals in integer minor units, then converted back once — exact, no
        // float drift across the per-payslip sum.
        const totalGross = money.minorToDecimal(
            money.sum(payslips.map((p) => money.decimalToMinor(p.grossAmount, payrollRun.currencyCode))),
            payrollRun.currencyCode,
        );
        const totalDeductions = money.minorToDecimal(
            money.sum(payslips.map((p) => money.decimalToMinor(p.totalDeductions, payrollRun.currencyCode))),
            payrollRun.currencyCode,
        );
        const totalNet = money.minorToDecimal(
            money.sum(payslips.map((p) => money.decimalToMinor(p.netAmount, payrollRun.currencyCode))),
            payrollRun.currencyCode,
        );

        // Update payroll run with totals (scoped). Record the rule version +
        // as-of so the run is reproducible against the rates in effect.
        await prisma.payrollRun.updateMany({
            where: withTenant(tenantId, { id }),
            data: {
                status: 'COMPLETED',
                totalGross,
                totalDeductions,
                totalNet,
                employeeCount: payslips.length,
                processedAt: new Date(),
                ruleVersion,
                ratesEffectiveAt
            }
        });

        const updatedRun = await getPayrollRunById(id, tenantId);

        // Create audit log (tenant-stamped)
        await prisma.payrollAuditLog.create({
            data: {
                tenantId: tenantId ?? null,
                action: 'PAYROLL_PROCESSED',
                details: `Payroll run processed for period ${payrollRun.periodStart.toISOString().split('T')[0]} to ${payrollRun.periodEnd.toISOString().split('T')[0]}`,
                payrollRunId: id,
                // HR-01 / T-P4.2 — the payroll run carries C4 money
                // (grossAmount/netAmount/totalDeductions and nested salary).
                // Redact those before persisting the audit diff so plaintext
                // C4 never lands in payroll_audit_logs.
                oldValues: JSON.stringify(redactC4(payrollRun)),
                newValues: JSON.stringify(redactC4(updatedRun))
            }
        });

        return updatedRun;
    } catch (error) {
        // Mark as failed if processing fails (scoped)
        await prisma.payrollRun.updateMany({
            where: withTenant(tenantId, { id }),
            data: { status: 'FAILED' }
        });
        throw error;
    }
};

// NOTE (HR-02 / T-P4.1): the legacy `calculateEmployeePay`, `calculatePeriodSalary`
// and `calculateTaxes` (hardcoded grossAmount*0.15 / *0.05, Float math) were
// REMOVED. Their behaviour now lives in the exported, pure, deterministic engine
// core above (buildPayslipFromInputs / calculatePeriodSalaryMinor /
// computeProgressiveTaxMinor) which processPayrollRun drives — the same code the
// golden-file regression test exercises (no mock copy of the logic).

const getBaseSalaryEarningTypeId = async (tenantId) => {
    let earningType = await prisma.payrollEarningType.findFirst({
        where: withTenant(tenantId, { code: 'BASE_SALARY' })
    });

    if (!earningType) {
        earningType = await prisma.payrollEarningType.create({
            data: {
                tenantId: tenantId ?? null,
                code: 'BASE_SALARY',
                name: 'Base Salary',
                type: 'EARNING',
                isTaxable: true
            }
        });
    }

    return earningType.id;
};

const getOrCreateDeductionType = async (code, name, tenantId) => {
    let deductionType = await prisma.payrollDeductionType.findFirst({
        where: withTenant(tenantId, { code })
    });

    if (!deductionType) {
        deductionType = await prisma.payrollDeductionType.create({
            data: {
                tenantId: tenantId ?? null,
                code,
                name,
                type: 'DEDUCTION'
            }
        });
    }

    return deductionType.id;
};

// HR-02 / T-P4.1 — APPROVAL GATE with separation of duties.
//
// A COMPLETED run must be APPROVED by a human who is DISTINCT from the employee
// that processed it before it can be FINALIZED. approvePayrollRun records the
// approver (must differ from processedBy — no self-approval) and moves the run
// to APPROVED. finalizePayrollRun then requires status===APPROVED with a
// recorded approver. The check compares integer employee ids.
export const approvePayrollRun = async (id, approverId, tenantId) => {
  const payrollRun = await prisma.payrollRun.findFirst({ where: withTenant(tenantId, { id }) });
  if (!payrollRun) throw new Error('Payroll run not found');

  if (payrollRun.status !== 'COMPLETED') {
    throw new Error('Only COMPLETED payroll runs can be approved');
  }

  const approver = toInt(approverId);
  if (approver === null) {
    throw new Error('HR-2010 approver id is required to approve a payroll run');
  }

  // Separation of duties: the approver MUST differ from the processor.
  if (payrollRun.processedBy != null && approver === payrollRun.processedBy) {
    throw new Error('HR-2011 self-approval forbidden: the approver must be distinct from the processor (same employee)');
  }

  await prisma.payrollRun.updateMany({
    where: withTenant(tenantId, { id }),
    data: { status: 'APPROVED', approvedBy: approver, approvedAt: new Date() }
  });

  await prisma.payrollAuditLog.create({
    data: {
      tenantId: tenantId ?? null,
      action: 'PAYROLL_APPROVED',
      // The approver id is recorded in approvedBy on the run; we keep it out of
      // the audit row's employeeId FK column (which references Employee) so the
      // audit write never couples to whether the actor is a payroll Employee.
      details: `Payroll run approved by employee ${approver} (processor was ${payrollRun.processedBy ?? 'unknown'})`,
      payrollRunId: id
    }
  });

  await logAction({
    employeeId: approver,
    type: 'Update',
    module: 'Payroll Run',
    result: 'SUCCESS',
    notes: `Payroll run "${id}" approved`
  });

  return getPayrollRunById(id, tenantId);
};

export const finalizePayrollRun = async (id, updatedBy, tenantId, ctx = {}) => {
  const payrollRun = await prisma.payrollRun.findFirst({ where: withTenant(tenantId, { id }) });
  if (!payrollRun) throw new Error('Payroll run not found');

  // X-07 — If-Match / 412 optimistic concurrency (opt-in via ctx.ifMatch). A
  // finalize racing a concurrent re-process/approve is rejected, not clobbered.
  assertIfMatch(ctx.ifMatch, payrollRun);

  // Approval gate: a run is only finalizable once it has been APPROVED by a
  // distinct approver. A COMPLETED-but-unapproved run is blocked here.
  if (payrollRun.status !== 'APPROVED') {
    throw new Error('HR-2012 payroll run requires approval before it can be finalized');
  }
  if (payrollRun.approvedBy == null) {
    throw new Error('HR-2012 payroll run requires approval before it can be finalized');
  }
  // Defence in depth: re-assert separation of duties at finalize time too, in
  // case the approval row was tampered with.
  if (payrollRun.processedBy != null && payrollRun.approvedBy === payrollRun.processedBy) {
    throw new Error('HR-2011 self-approval forbidden: the approver must be distinct from the processor');
  }

  // M1-HR: the payslip + run FINALIZED flips, the audit row, and the
  // hr.payroll.run_finalized.v1 outbox event commit or roll back together
  // (outbox-on-write, validate-before-write). The event is ids-only +
  // tenant-scoped from the run's verified tenant.
  await tenantTransaction(prisma, async (tx) => {
    await tx.payrollPayslip.updateMany({
      where: withTenant(tenantId, { payrollRunId: id }),
      data: { status: 'FINALIZED' }
    });

    // HR-PAYSLIPALERT-02: gather the affected employees' ids (ids-only, no PII)
    // in the SAME tx/tenant scope so the run_finalized event carries the
    // recipient list the notification-hub mapper fans "payslip ready" out to.
    // employeeCount is derived from the distinct id list to stay consistent.
    const payslips = await tx.payrollPayslip.findMany({
      where: withTenant(tenantId, { payrollRunId: id }),
      select: { employeeId: true }
    });
    const employeeIds = [...new Set(payslips.map((p) => p.employeeId))];
    const employeeCount = employeeIds.length;

    // Move the run itself to FINALIZED so it is past the approval gate and can no
    // longer be re-processed (PROCESSABLE_STATUSES excludes FINALIZED).
    await tx.payrollRun.updateMany({
      where: withTenant(tenantId, { id }),
      data: { status: 'FINALIZED' }
    });

    await tx.payrollAuditLog.create({
      data: {
        tenantId: tenantId ?? null,
        action: 'PAYROLL_FINALIZED',
        details: `Payroll run finalized and ready for distribution (approved by ${payrollRun.approvedBy})`,
        payrollRunId: id
      }
    });

    const event = payrollRunFinalizedEvent(
      {
        id,
        tenantId: payrollRun.tenantId ?? tenantId,
        periodStart: payrollRun.periodStart ? new Date(payrollRun.periodStart).toISOString().slice(0, 10) : null,
        periodEnd: payrollRun.periodEnd ? new Date(payrollRun.periodEnd).toISOString().slice(0, 10) : null,
        employeeCount,
        employeeIds,
      },
      { actorId: ctx.actorId ?? updatedBy, correlationId: ctx.correlationId }
    );
    if (event) await enqueueHrDomainEvent(tx, event);
  });

  await logAction({
    employeeId: toInt(updatedBy),
    type: "Update",
    module: "Payroll Run",
    result: "SUCCESS",
    notes: `Payroll run "${id}" finalized successfully`
  });

  return getPayrollRunById(id, tenantId);
};
export const cancelPayrollRun = async (id, deletedBy, tenantId) => {
  const payrollRun = await prisma.payrollRun.findFirst({ where: withTenant(tenantId, { id }) });
  if (!payrollRun) throw new Error('Payroll run not found');

  if (payrollRun.status === 'COMPLETED') {
    throw new Error('Cannot cancel a completed payroll run');
  }

  // Create audit log BEFORE deleting the run (FK constraint requires the run to exist)
  await prisma.payrollAuditLog.create({
    data: {
      tenantId: tenantId ?? null,
      action: 'PAYROLL_CANCELLED',
      details: 'Payroll run cancelled',
      payrollRunId: id
    }
  });

  await prisma.payrollPayslip.deleteMany({
    where: withTenant(tenantId, { payrollRunId: id })
  });

  // deleteMany (not delete) so the tenant predicate guards the destructive op:
  // a cross-tenant id deletes zero rows (we already verified ownership above).
  await prisma.payrollRun.deleteMany({
    where: withTenant(tenantId, { id })
  });

  await logAction({
    employeeId: Number(deletedBy),
    type: "Delete",
    module: "Payroll Run",
    result: "SUCCESS",
    notes: `Payroll run "${id}" cancelled and deleted`
  });
};


// Earning Type Operations
export const getEarningTypes = async (tenantId) => {
    return prisma.payrollEarningType.findMany({
        where: withTenant(tenantId, {}),
        orderBy: { name: 'asc' }
    });
};

export const createEarningType = async (data, createdBy, tenantId) => {
  const create = await prisma.payrollEarningType.create({ data: { ...data, tenantId: tenantId ?? null } });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Earning Type",
    result: "SUCCESS",
    notes: `Earning Type "${create.name}" created`
  });

  return create;
};


export const updateEarningType = async (id, data, updatedBy, tenantId) => {
  // Ownership check then scoped update; a cross-tenant id is not-found.
  const existing = await prisma.payrollEarningType.findFirst({ where: withTenant(tenantId, { id }) });
  if (!existing) throw new Error('Earning type not found');

  await prisma.payrollEarningType.updateMany({
    where: withTenant(tenantId, { id }),
    data
  });
  const update = await prisma.payrollEarningType.findFirst({ where: withTenant(tenantId, { id }) });

  await logAction({
    employeeId: Number(updatedBy),
    type: "Update",
    module: "Earning Type",
    result: "SUCCESS",
    notes: `Earning Type "${update.name}" updated`
  });

  return update;
};
// Deduction Type Operations
export const getDeductionTypes = async (tenantId) => {
    return prisma.payrollDeductionType.findMany({
        where: withTenant(tenantId, {}),
        orderBy: { name: 'asc' }
    });
};

export const createDeductionType = async (data, createdBy, tenantId) => {
  const create = await prisma.payrollDeductionType.create({ data: { ...data, tenantId: tenantId ?? null } });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Deduction Type",
    result: "SUCCESS",
    notes: `Deduction Type "${create.name}" created`
  });

  return create;
};

export const updateDeductionType = async (id, data, updatedBy, tenantId) => {
  const existing = await prisma.payrollDeductionType.findFirst({ where: withTenant(tenantId, { id }) });
  if (!existing) throw new Error('Deduction type not found');

  await prisma.payrollDeductionType.updateMany({
    where: withTenant(tenantId, { id }),
    data
  });
  const update = await prisma.payrollDeductionType.findFirst({ where: withTenant(tenantId, { id }) });

  await logAction({
    employeeId: Number(updatedBy),
    type: "Update",
    module: "Deduction Type",
    result: "SUCCESS",
    notes: `Deduction Type "${update.name}" updated`
  });

  return update;
};

// Employee Payroll Data Operations
export const getEmployeePayrollData = async (employeeId, tenantId) => {
    const [employmentTerms, assignments, bankDetails, payslips] = await Promise.all([
        prisma.employmentTerms.findMany({
            where: withTenant(tenantId, { employeeId }),
            orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }]
        }),
        prisma.payrollAssignment.findMany({
            where: withTenant(tenantId, { employeeId, isActive: true }),
            include: {
                earningType: true,
                deductionType: true
            }
        }),
        prisma.bankDetail.findMany({
            where: withTenant(tenantId, { employeeId })
        }),
        prisma.payrollPayslip.findMany({
            where: withTenant(tenantId, { employeeId }),
            include: {
                payrollRun: true,
                earnings: {
                    include: {
                        earningType: true
                    }
                },
                deductions: {
                    include: {
                        deductionType: true
                    }
                }
            },
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
            take: 6 // Last 6 payslips
        })
    ]);

    return {
        employmentTerms,
        assignments,
        bankDetails,
        recentPayslips: payslips
    };
};


export const createEmploymentTerms = async (data, createdBy, tenantId) => {
  // strip the non-column `createdBy` the controller folds into the payload
  // (legacy shape) so the scoped create only persists real columns + tenantId.
  const { createdBy: _ignored, ...termsData } = data;
  const create = await prisma.employmentTerms.create({
    data: { ...termsData, tenantId: tenantId ?? null }
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Employment Terms",
    result: "SUCCESS",
    notes: `Employment terms created for employee ID: ${create.employeeId || "N/A"}`
  });

  return create;
};

export const createPayrollAssignment = async (data, createdBy, tenantId) => {
  // strip the non-column `createdBy` the controller folds into the payload
  // (legacy shape) so the scoped create only persists real columns + tenantId.
  const { createdBy: _ignored, ...assignmentData } = data;
  if (assignmentData.amount != null) {
    assignmentData.amount = money.decimalToPersistence(assignmentData.amount);
  }
  const create = await prisma.payrollAssignment.create({
    data: { ...assignmentData, tenantId: tenantId ?? null },
    include: {
      earningType: true,
      deductionType: true
    }
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Payroll Assignment",
    result: "SUCCESS",
    notes: `Payroll assignment created for employee ID: ${create.employeeId} (EarningType: ${create.earningTypeId || "N/A"}, DeductionType: ${create.deductionTypeId || "N/A"})`
  });

  return create;
};

// Payslip Operations
export const getPayslips = async ({ page, limit, payrollRunId, employeeId, tenantId }) => {
    const skip = (page - 1) * limit;
    const where = {};

    if (payrollRunId) where.payrollRunId = parseInt(payrollRunId);
    if (employeeId) where.employeeId = parseInt(employeeId);
    const scoped = withTenant(tenantId, where);

    const [payslips, total] = await Promise.all([
        prisma.payrollPayslip.findMany({
            where: scoped,
            skip,
            take: parseInt(limit),
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
            include: {
                employee: {
                    select: { id: true, first_name: true, last_name: true, job_title: true }
                },
                payrollRun: true,
                earnings: {
                    include: {
                        earningType: true
                    }
                },
                deductions: {
                    include: {
                        deductionType: true
                    }
                }
            }
        }),
        prisma.payrollPayslip.count({ where: scoped })
    ]);

    return {
        payslips,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export const getPayslipById = async (id, tenantId) => {
    // findFirst so the tenant predicate applies: a cross-tenant payslip id
    // resolves to null → controller returns 404 (never another tenant's slip).
    return prisma.payrollPayslip.findFirst({
        where: withTenant(tenantId, { id }),
        include: {
            employee: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    job_title: true
                }
            },
            payrollRun: true,
            earnings: {
                include: {
                    earningType: true
                }
            },
            deductions: {
                include: {
                    deductionType: true
                }
            }
        }
    });
};

export const distributePayslip = async (id, createdBy, tenantId) => {
  const payslip = await prisma.payrollPayslip.findFirst({
    where: withTenant(tenantId, { id })
  });

  if (!payslip) {
    throw new Error("Payslip not found");
  }

  if (payslip.status !== "FINALIZED") {
    throw new Error("Only finalized payslips can be distributed");
  }

  await prisma.payrollPayslip.updateMany({
    where: withTenant(tenantId, { id }),
    data: {
      status: "DISTRIBUTED",
      distributedAt: new Date()
    }
  });
  const updatedPayslip = await prisma.payrollPayslip.findFirst({ where: withTenant(tenantId, { id }) });

  // ✅ Centralized audit log entry
  await logAction({
    employeeId: Number(createdBy),
    type: "Distribute",
    module: "Payslip",
    result: "SUCCESS",
    notes: `Payslip (ID: ${id}) distributed to employee ID: ${payslip.employeeId}`
  });

  return updatedPayslip;
};

export const getEmployeePayslips = async (employeeId, { page, limit, tenantId }) => {
    const skip = (page - 1) * limit;
    const where = withTenant(tenantId, { employeeId });

    const [payslips, total] = await Promise.all([
        prisma.payrollPayslip.findMany({
            where,
            skip,
            take: parseInt(limit),
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
            include: {
                payrollRun: true,
                earnings: {
                    include: {
                        earningType: true
                    }
                },
                deductions: {
                    include: {
                        deductionType: true
                    }
                }
            }
        }),
        prisma.payrollPayslip.count({ where })
    ]);

    return {
        payslips,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

// Tax Rate Operations
export const getTaxRates = async (countryCode, tenantId) => {
    const where = withTenant(tenantId, countryCode ? { countryCode } : {});
    return prisma.taxRate.findMany({
        where,
        orderBy: [{ bracketMin: 'asc' }, { id: 'asc' }]
    });
};

export const createTaxRate = async (data, createdBy, tenantId) => {
  const exactData = { ...data };
  for (const field of ['bracketMin', 'bracketMax', 'baseTax']) {
    if (exactData[field] != null) exactData[field] = money.decimalToPersistence(exactData[field]);
  }
  const create = await prisma.taxRate.create({
    data: { ...exactData, tenantId: tenantId ?? null }
  });

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Tax Rate",
    result: "SUCCESS",
    notes: `Tax rate for country "${create.countryCode}" and bracket "${create.bracketMin} - ${create.bracketMax}" created successfully`
  });

  return create;
};
// Audit Log Operations
export const getAuditLogs = async ({ page, limit, payrollRunId, payslipId, tenantId }) => {
    const skip = (page - 1) * limit;
    const where = {};

    if (payrollRunId) where.payrollRunId = parseInt(payrollRunId);
    if (payslipId) where.payslipId = parseInt(payslipId);
    const scoped = withTenant(tenantId, where);

    const [auditLogs, total] = await Promise.all([
        prisma.payrollAuditLog.findMany({
            where: scoped,
            skip,
            take: parseInt(limit),
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
            include: {
                payrollRun: {
                    select: { id: true, periodStart: true, periodEnd: true }
                },
                payslip: {
                    select: { id: true, employeeId: true }
                },
                employee: {
                    select: { id: true, first_name: true, last_name: true }
                }
            }
        }),
        prisma.payrollAuditLog.count({ where: scoped })
    ]);

    return {
        auditLogs,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

export default {
    getPayrollRuns,
    getPayrollRunById,
    createPayrollRun,
    processPayrollRun,
    approvePayrollRun,
    finalizePayrollRun,
    cancelPayrollRun,
    getEarningTypes,
    createEarningType,
    updateEarningType,
    getDeductionTypes,
    createDeductionType,
    updateDeductionType,
    getEmployeePayrollData,
    createEmploymentTerms,
    createPayrollAssignment,
    getPayslips,
    getPayslipById,
    distributePayslip,
    getEmployeePayslips,
    getTaxRates,
    createTaxRate,
    getAuditLogs
};
