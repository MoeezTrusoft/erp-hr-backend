const payrollError = (message, status = 409) => Object.assign(new Error(message), {status});
import { loadDeductionRules, snapshotDeductionRules } from './deductionRules.service.js';
import { payrollAssignments, employeeCode, assertPayrollPeriod } from '../lib/payrollConfiguration.js';
import { payrollReadiness, assertReady } from './payrollReadiness.service.js';
import { loadSource } from './approval/adapters.js';
import { settlePayrollLoans, reservePayrollLoans } from './payrollLoans.service.js';
import { legacyDecision } from "./approval/legacy.js";
import { ruleDeductions } from '../lib/attendanceAnomalyRules.js';
import { priceRuleDays, RULE_DEDUCTION_CODE, ADJUSTMENT_CODE, releaseFailedCarry } from './attendanceRulePayroll.service.js';
import { lockAttendancePeriod } from './attendancePeriod.service.js';
import { loadAttendanceRuntime } from './attendanceSetup.service.js';
import { dateRange, employedOn, badSetup } from '../lib/attendanceDates.js';
import { approvedLeaveCoverage } from "../lib/approvedLeaveCoverage.js";
import { calculatePayrollPaidDays } from '../lib/payrollPaidDays.js';
import { manualAttendanceFactor, isHeadendEmployee } from '../lib/monthlyPayrollAttendance.js';
import { createHash } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { logAction } from "../utils/logs.js";
import { redactC4 } from "../lib/c4Redaction.js";
import * as money from "../lib/money.js";
import { withTenant } from "../lib/tenancy.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { payrollRunFinalizedEvent } from "./hrEvents.js";
import { assertIfMatch, versionOf } from "../lib/optimisticConcurrency.js";

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
    ATTENDANCE_RULES_V2: 'Management-disapproved attendance',
    ATTENDANCE_RULES_ADJUSTMENT: 'Prior-period attendance adjustment',
    ATTENDANCE_DEDUCTION: 'Attendance Deduction',
    EMPLOYMENT_PRORATION: 'Joining/leaving date deduction',
    MANAGEMENT_ATTENDANCE_DEDUCTION: 'Management Attendance Deduction',
    BENEFIT_CONTRIBUTION: 'Benefit Contribution',
    LOAN_REPAYMENT: 'Loan Repayment',
    LWP_RECOVERY: 'Unpaid Leave (LWP) Recovery',
    // N-01 — unexcused absence + half-day day-credit loss, priced on the SAME
    // daily rate as LWP (one concept, one formula). Gated on
    // PayrollRuleConfig.absenceRecoveryEnabled (ships false — plan 20 T-0.3),
    // because enabling it changes real money behavior.
    ABSENCE_RECOVERY: 'Absence Recovery',
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
 * bracketMin ascending. "Effective" = status ACTIVE, effectiveFrom <= asOf AND
 * (effectiveTo is null OR effectiveTo >= asOf). This is the versioned snapshot —
 * a future rate row, a foreign-country row, or a DEACTIVATED slab is never
 * selected (four tenants carried INACTIVE legacy slabs alongside ACTIVE
 * monthly-normalized ones; ignoring status double-counted brackets and drove
 * computed tax to ≈0). Pure: does not touch the DB.
 */
export const selectEffectiveTaxRates = (rateRows, { countryCode, asOf }) => {
    const at = asOf instanceof Date ? asOf : new Date(asOf);
    return (rateRows || [])
        .filter((r) => r.countryCode === countryCode)
        .filter((r) => r.status == null || r.status === 'ACTIVE')
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
export const buildPayslipFromInputs = ({ employee, employmentTerm, assignments = [], payrollRun, taxRateRows = [], asOf, bridges = {}, ruleConfig = {} }) => {    const at = asOf || payrollRun?.periodEnd;
    const earnings = [];
    const monthlyEarnings = new Map();
    const deductions = [];
    const currency = payrollRun.currencyCode || employmentTerm?.currency || 'USD';
    let grossMinor = 0n;
    // N-13 — the TAXABLE base for income tax. Earning-type taxability
    // (PayrollEarningType.isTaxable) was ignored: the engine taxed the whole
    // package, so "500K salary, only 200K taxable" was un-expressable. Lines
    // whose resolved type is explicitly non-taxable are excluded; everything
    // else (base salary, overtime, employer benefits, unflagged allowances)
    // stays taxable — the earning-type default.
    let taxableMinor = 0n;
    // N-21 — TAX-BASE UPLIFT: the prorated share of fixed earnings is added
    // back for the withholding base. Section 149 withholds on the CONTRACTED
    // monthly salary; absence days reduce net pay through the deduction lines
    // (already taken out) — they don't shrink the tax base. HR's August 2026
    // register proves the convention: Abdullah's gross is prorated to 84,194
    // (2 days off) yet his tax is 400 = 1% of (90,000 − 50,000), and Meesam
    // (19/31 earned 36,774) still pays 100 = 1% of (60,000 − 50,000). For a
    // full-month employee the uplift is zero and the base is unchanged.
    let taxPackageUplift = 0n;
    // HR-PAYROLL-DEDUCTION-BASIS-01 — base + fixed allowances, i.e. the monthly
    // package the employee is contracted for. See step 7 for why this is not
    // grossMinor.
    let contractualMinor = 0n;

    // PRORATION: the share of the run the employee was actually employed for.
    // HR-PAYROLL-EMPLOYMENT-PERIOD-01 — previously this passed
    // `employee.term_date || employee.terminationDate`, and Employee has
    // neither column, so the leaver branch never ran. Employment periods carry
    // the leaving date, and a re-hire is two of them.
    // midMonthJoinerProration toggle: when OFF, skip proration entirely (factor = 1.0).
    let prorationFactor = ruleConfig.midMonthJoinerProration === false
        ? 1_000_000n
        : computeProrationFactor(
            payrollRun.periodStart,
            payrollRun.periodEnd,
            employee?.employmentPeriods?.length
                ? employee.employmentPeriods
                : (employee?.hire_date || employee?.joining_date || employee?.hireDate),
        );

    prorationFactor = manualAttendanceFactor(employee, payrollRun, bridges.manualAttendance,
        isHeadendEmployee(employee)
            ? computeProrationFactor(payrollRun.periodStart, payrollRun.periodEnd, employee?.employmentPeriods?.length ? employee.employmentPeriods : (employee?.hire_date || employee?.joining_date || employee?.hireDate))
            : prorationFactor);
    if (isHeadendEmployee(employee)) {
        bridges = {...bridges, attendanceRows:[], anomalyRows:[], attendanceDeductionLines:[], attendanceDeductionRules:[], lwpDays:0};
    }



    // 1) Base salary (if the employee has employment terms), prorated if mid-month start/end.
    if (employmentTerm) {
        const fullBaseMinor = calculatePeriodSalaryMinor(employmentTerm, payrollRun);
        let baseMinor = fullBaseMinor;
        // HR-PAYROLL-EMPLOYMENT-PERIOD-02 — `> 0n` used to be part of this
        // guard, so a factor of exactly ZERO skipped proration and paid the
        // base salary IN FULL. Zero is the case that matters most: somebody who
        // was not employed for any part of this run. Employment terms outlive
        // employment, so "has terms" must never imply "gets paid".
        const isProrated = prorationFactor < 1_000_000n;
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
        monthlyEarnings.set(earnings.at(-1), fullBaseMinor);
        grossMinor = money.add(grossMinor, baseMinor);
        // HR-PAYROLL-DEDUCTION-BASIS-01 — the CONTRACTUAL monthly package, which
        // is what a deducted day is charged against. Tracked separately from
        // grossMinor because gross also accumulates overtime and employer
        // benefits, and working overtime must not make a different day of
        // absence cost more.
        //
        // N-19 — the basis must be the UNPRORATED package. Step 7 divides this
        // by periodDays a second time, so feeding it the prorated salary docks
        // a partial-month employee twice (Meesam: 19/31 proration THEN 2
        // absence days priced on the prorated package ÷ 31 — HR charges one
        // stream at the full daily rate: 60,000/31 × 2). For a full-month
        // employee proration is 1.0 and both agree.
        contractualMinor = money.add(contractualMinor, fullBaseMinor);
        taxableMinor = money.add(taxableMinor, baseMinor);
        if (isProrated && fullBaseMinor > baseMinor) {
            taxPackageUplift = money.add(taxPackageUplift, money.sub(fullBaseMinor, baseMinor));
        }
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
                taxableMinor = money.add(taxableMinor, otAmountMinor);
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
                taxableMinor = money.add(taxableMinor, amt);
            }
        }
    }

    // 4) Assignment-driven earnings & deductions, in declared order. A flat
    //    `amount` is taken verbatim; a `rate` applies to gross-so-far (matching
    //    the legacy semantics) — both in minor units, rounded half-up once.
    for (const assignment of assignments) {
        if (assignment.earningType) {
            // HR-PAYROLL-EMPLOYMENT-PERIOD-02 — a FIXED allowance is prorated
            // with the base. Without this a leaver kept every allowance in full:
            // the August dry-run showed affan at 0% and still drawing 13,750,
            // exactly the 55% allowance share of a 25,000 package. The comment
            // below already treats allowances as part of the contracted package
            // when charging a deducted day; paying the month must agree.
            //
            // A RATE-based assignment is not touched — it multiplies gross-so-far,
            // which already carries the prorated base, so applying the factor
            // again would shrink it twice.
            const amountMinor = assignment.amount != null
                ? applyProration(money.decimalToMinor(assignment.amount, currency), prorationFactor)
                : money.mulRate(grossMinor, assignment.rate || '0');
            earnings.push({
                earningTypeId: assignment.earningType.id,
                code: assignment.earningType.code, taxable:assignment.earningType.isTaxable !== false,
                amount: money.minorToDecimal(amountMinor, currency),
                description: assignment.earningType.name,
            });
            grossMinor = money.add(grossMinor, amountMinor);
            // Allowances are part of the contracted package (house, transport,
            // medical, utilities), so they count toward a deducted day.
            // N-19 — the UNPRORATED amount: see the base-salary note above.
            const fullAllowanceMinor = assignment.amount != null
                ? money.decimalToMinor(assignment.amount, currency)
                : null;
            if (fullAllowanceMinor != null) monthlyEarnings.set(earnings.at(-1),fullAllowanceMinor);
            // N-13 — an explicitly non-taxable earning type leaves the tax base.
            if (assignment.earningType.isTaxable !== false) {
                taxableMinor = money.add(taxableMinor, amountMinor);
                // N-21 — a prorated fixed allowance adds back its full share so
                // the withholding base is the contracted package (see
                // taxPackageUplift above).
                if (fullAllowanceMinor != null && amountMinor < fullAllowanceMinor) {
                    taxPackageUplift = money.add(taxPackageUplift, money.sub(fullAllowanceMinor, amountMinor));
                }
            }
            contractualMinor = money.add(contractualMinor, fullAllowanceMinor ?? amountMinor);
        } else if (assignment.deductionType) {
            const amountMinor = assignment.amount != null
                ? money.decimalToMinor(assignment.amount, currency)
                : money.mulRate(grossMinor, assignment.rate || '0');
            deductions.push({
                deductionTypeId: assignment.deductionType.id,
                code: assignment.deductionType.code,
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

    // 6) BRIDGE: Loan repayments → Deduction (with garnishment cap)
    const loanBalances = new Map(); // deduction line → remaining loan balance (minor)
    if (ruleConfig.garnishmentRecovery !== false && bridges.loanLines?.length > 0) {
        // [A-02] one default, one source: the config service publishes 33, so
        // the engine fallback is 33 too — never the unsigned 40. (T-2.4/A1.)
        const capPct = ruleConfig.garnishmentCapPct != null
            ? BigInt(Math.round(ruleConfig.garnishmentCapPct))
            : 33n;
        const grossLimit = ruleConfig.garnishmentRecovery === false
            ? grossMinor // no cap — allow full deduction
            : grossMinor * capPct / 100n;
        let loanTotalMinor = 0n;
        for (const loan of bridges.loanLines) {
            const loanMinor = BigInt(loan.amountMinor || 0);
            const cappedMinor = loanTotalMinor + loanMinor > grossLimit
                ? grossLimit - loanTotalMinor
                : loanMinor;
            if (cappedMinor > 0n) {
                const line = {
                    deductionTypeId: null,
                    code: 'LOAN_REPAYMENT',
                    amount: money.minorToDecimal(cappedMinor, currency),
                    description: loan.name || 'Loan Repayment',
                    loanId: loan.loanId,
                };
                if (loan.outstandingMinor != null) loanBalances.set(line, BigInt(loan.outstandingMinor));
                deductions.push(line);
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
    let attendanceBasisMinor = '0', attendancePeriodDays = 1;
    const assessment = ruleDeductions(bridges.anomalyRows || [], {from:payrollRun.periodStart,to:payrollRun.periodEnd,rules:bridges.deductionRules});
    if (employmentTerm) {
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

        if (ruleConfig.lwpRecovery !== false && bridges.lwpDays > 0) {
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

        attendanceBasisMinor = String(basisMinor);
        attendancePeriodDays = periodDays;
        const ruleAmount = priceRuleDays(assessment.days,basisMinor,periodDays,currency);
        // The frozen basis above makes later revisions reproducible. Emit a line
        // only for disapproved day quantities (even if the salary basis is zero).
        if(assessment.days>0)deductions.push({deductionTypeId:null,code:RULE_DEDUCTION_CODE,
            amount:money.minorToDecimal(ruleAmount,currency),description:`Management-disapproved attendance: ${assessment.days} day(s)`});
    }
    for(const adjustment of bridges.attendanceAdjustments || []) {
        deductions.push({deductionTypeId:null,code:ADJUSTMENT_CODE,
            amount:money.minorToDecimal(BigInt(adjustment.amountMinor),currency),
            description:`Prior-period attendance adjustment #${adjustment.id} from payslip ${adjustment.sourcePayslipId}`});
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
    // N-13 — tax the TAXABLE base, not the full package.
    // N-21 — restore the contracted-package share of prorated fixed earnings
    // so withholding follows Section 149 (see taxPackageUplift above).
    const taxBaseMinor = money.add(taxableMinor, isHeadendEmployee(employee) && prorationFactor === 0n ? 0n : taxPackageUplift);
    let taxMinor = computeProgressiveTaxMinor(taxBaseMinor, sorted, currency);
    const nilEstimate = employee?.payrollNilTaxEstimate;
    if (nilEstimate) {
        // A documented annual estimate is scoped to one employee/run. Never
        // turn a monthly salary amount into a blanket tax exemption.
        const firstTaxable = sorted.find(r=>Number(r.rate)>0);
        const annual = money.decimalToMinor(String(nilEstimate.estimatedAnnualTaxableSalary),currency);
        if (payrollRun.countryCode!=='PK'||currency!=='PKR'||!firstTaxable||nilEstimate.otherSalaryIncomeConfirmed!==true||
            nilEstimate.periodStart!==isoDate(payrollRun.periodStart)||nilEstimate.periodEnd!==isoDate(payrollRun.periodEnd)||
            nilEstimate.taxYearStart>isoDate(payrollRun.periodStart)||nilEstimate.taxYearEnd<isoDate(payrollRun.periodEnd)||
            !/^\d{4}-07-01$/.test(nilEstimate.taxYearStart||'')||!/^\d{4}-06-30$/.test(nilEstimate.taxYearEnd||'')||
            Number(nilEstimate.taxYearEnd.slice(0,4))!==Number(nilEstimate.taxYearStart.slice(0,4))+1||
            money.decimalToMinor(String(nilEstimate.monthlyTaxableSalary),currency)!==taxBaseMinor||
            annual<0n||annual>money.decimalToMinor(firstTaxable.bracketMin,currency)*12n)
            throw payrollError('Annual nil-tax estimate is invalid or stale; review the payroll tax projection');
        taxMinor=0n;
    }
    if (taxMinor > 0n || sorted.length > 0) {
        deductions.push({
            deductionTypeId: null,
            code: 'INCOME_TAX',
            amount: money.minorToDecimal(taxMinor, currency),
            description: nilEstimate ? `Income Tax (nil: confirmed annual taxable salary estimate ${nilEstimate.estimatedAnnualTaxableSalary} ${currency})` : 'Income Tax',
        });
    }

    const totalDeductionsMinor = money.sum(deductions.map((d) => money.decimalToMinor(d.amount, currency)));
    const netMinor = money.sub(grossMinor, totalDeductionsMinor);

    // N-22 — WHOLE-RUPEE PERSISTENCE (operator ruling 2026-09-17): every line
    // amount is rounded HALF-UP to a WHOLE major unit (PKR rupee) at the engine
    // boundary, and the headers are RECOMPUTED as the exact sum of the rounded
    // lines. A payslip therefore always foots in whole rupees:
    //   Σ(earnings) == grossAmount, Σ(deductions) == totalDeductions,
    //   grossAmount − totalDeductions == netAmount.
    // The per-day pricing and proration arithmetic above still runs paisa-exact
    // (that precision is what prices a deducted day correctly); rounding happens
    // ONCE, here, at persistence — never inside the accumulation, so repeated
    // re-processes are stable (round-once, not round-per-step). Figures that
    // were already whole rupees (Qasim's 13,000 tax, flat salary lines) are
    // bit-identical before and after.
    const roundToWholeMajor = (raw) => roundToWholeMajorHalfUp(raw, currency);
    for (const line of earnings) {
        line.amount = money.minorToDecimal(
            roundToWholeMajor(money.decimalToMinor(line.amount, currency)),
            currency,
        );
    }
    for (const line of deductions) {
        const exact = money.decimalToMinor(line.amount, currency);
        let rounded = roundToWholeMajor(exact);
        // D-10: a loan line never reserves more than the remaining balance, and
        // the instalment that clears the loan keeps its exact amount, so
        // finalization settles it to zero instead of failing or leaving dust.
        const balance = loanBalances.get(line);
        if (balance != null && (exact >= balance || rounded > balance)) rounded = balance;
        line.amount = money.minorToDecimal(rounded, currency);
    }
    // Present monthly contractual earnings in full, with employment proration
    // shown separately. Apply after tax, loan caps and line rounding so net pay,
    // withholding and repayment amounts remain exactly as calculated above.
    // Headend manual attendance and zero-employment periods retain their rules.
    if (employmentTerm?.payFrequency === 'MONTHLY' && !isHeadendEmployee(employee) && prorationFactor > 0n && prorationFactor < 1_000_000n) {
        let adjustment = 0n;
        for (const [line,full] of monthlyEarnings) {
            const amount = roundToWholeMajor(full);
            adjustment += amount - money.decimalToMinor(line.amount,currency);
            line.amount = money.minorToDecimal(amount,currency);
            line.description = line.description.replace(/ \(prorated [\d.]+%\)/,'');
        }
        if (adjustment > 0n) {
            const utcDay=value=>{const d=new Date(value);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());};
            const periodDays=(utcDay(payrollRun.periodEnd)-utcDay(payrollRun.periodStart))/86400000+1;
            const excludedDays=Math.round(periodDays*(1-Number(prorationFactor)/1_000_000)*100)/100;
            deductions.push({deductionTypeId:null,code:'EMPLOYMENT_PRORATION',amount:money.minorToDecimal(adjustment,currency),description:`Joining/leaving date deduction (${excludedDays} days outside employment)`});
        }
    }
    const grossMinorRounded = money.sum(earnings.map((e) => money.decimalToMinor(e.amount, currency)));
    const totalDeductionsMinorRounded = money.sum(deductions.map((d) => money.decimalToMinor(d.amount, currency)));
    const netMinorRounded = money.sub(grossMinorRounded, totalDeductionsMinorRounded);

    return {
        employeeId: employee?.id ?? null,
        attendanceBasisMinor, attendancePeriodDays,
        ruleVersion,
        ratesEffectiveAt: new Date(at).toISOString(),
        grossAmount: money.minorToDecimal(grossMinorRounded, currency),
        totalDeductions: money.minorToDecimal(totalDeductionsMinorRounded, currency),
        netAmount: money.minorToDecimal(netMinorRounded, currency),
        prorationFactor: prorationFactor >= 1_000_000n ? 1.0 : Number(prorationFactor) / 1_000_000,
        payableDays: calculatePayrollPaidDays({payrollRun, prorationFactor:Number(prorationFactor) / 1_000_000, deductions}),
        earnings,
        deductions,
    };
};

const isoDate = (d) => new Date(d).toISOString().split('T')[0];

// N-22 — WHOLE-RUPEE rounding: half-up to a whole MAJOR unit in minor-space
// (PKR rupee = 100 minor). Pure so tests can reproduce the persistence order:
// compute paisa-exact FIRST (tax the exact base), then round the line ONCE.
// The major unit follows the currency's exponent (JPY 1, KWD 1000 minor).
export const roundToWholeMajorHalfUp = (raw, currency = 'PKR') => {
    const exponent = money.CURRENCY_EXPONENT[String(currency).toUpperCase()] ?? 2;
    const unit = 10n ** BigInt(exponent);
    const value = BigInt(raw);
    const sign = value < 0n ? -1n : 1n;
    const abs = value < 0n ? -value : value;
    return sign * ((abs + unit / 2n) / unit) * unit;
};

// T-1.2 / N-02 — repayment PLANNING for the loan bridge, extracted so both
// write branches (fresh create + re-process) share one decision. Production
// evidence (report 19, CHECK21/22): the re-process branch re-created the
// LoanRepayment and re-decremented outstandingMinor whenever a payslip was
// rebuilt — loans 6 and 8 now carry repayments exceeding principal.
//
// Contract:
//   existing != null            → SKIP. The repayment for [loan, run] already
//                                 exists; the recorded amount is the source of
//                                 truth even if the recomputed figure differs
//                                 (rules changed between re-processes).
//   otherwise                   → the installment, capped at the remaining
//                                 garnishment allowance; if nothing remains
//                                 under the cap, SKIP rather than plan 0.
//
// The write sites pair `skip === false` with EXACTLY ONE create + ONE
// decrement; the [loanId, payrollRunId] index (migration
// 20260909120000_absence_flag_loan_idx) backs the lookup and becomes a partial
// UNIQUE index once prod's legacy NULL-run rows are reconciled (T-1.3).
export const planLoanRepayment = ({ existing, installmentMinor, grossLimitMinor, usedMinor }) => {
    if (existing) return { skip: true };
    const installment = BigInt(installmentMinor || 0);
    if (installment <= 0n) return { skip: true };
    const limit = BigInt(grossLimitMinor ?? 0);
    const used = BigInt(usedMinor ?? 0);
    const remaining = limit - used;
    if (remaining <= 0n) return { skip: true };
    const amountMinor = installment > remaining ? remaining : installment;
    if (amountMinor <= 0n) return { skip: true };
    return { skip: false, amountMinor };
};

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
                            select: { id: true, employee_code: true }
                        }
                    }
                }
            }
        }),
        prisma.payrollRun.count({ where })
    ]);

    // Resolve processedBy and approvedBy employee IDs to names
    const empIds = [...new Set([
        ...payrollRuns.map(r => r.processedBy).filter(Boolean),
        ...payrollRuns.map(r => r.approvedBy).filter(Boolean),
    ])];
    let empMap = {};
    if (empIds.length > 0) {
        const emps = await prisma.employee.findMany({
            where: { id: { in: empIds }, tenant_id: tenantId },
            select: { id: true, employee_code: true },
        });
        empMap = Object.fromEntries(emps.map(e => [e.id, e.employee_code]));
    }

    const enrichedRuns = payrollRuns.map(r => ({
        ...r,
        // X-07: the value clients send back as If-Match on finalize.
        ...(versionOf(r) == null ? {} : { version: versionOf(r) }),
        processedByName: r.processedBy ? empMap[r.processedBy] || 'Employee code required' : null,
        approvedByName: r.approvedBy ? empMap[r.approvedBy] || 'Employee code required' : null,
    }));

    return {
        payrollRuns: enrichedRuns,
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
    const run = await prisma.payrollRun.findFirst({
        where: withTenant(tenantId, { id }),
        include: {
            payslips: {
                include: {
                    employee: {
                        select: { id: true, employee_code: true, job_title: true }
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
    // X-07: `version` is what a client sends back as If-Match on finalize.
    const version = versionOf(run);
    return version == null ? run : { ...run, version };
};

export const createPayrollRun = async (data, createdBy, tenantId) => {
  assertPayrollPeriod(data);
  const create = await tenantTransaction(prisma, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':payroll-period'},0))`;
    const existing = await tx.payrollRun.findFirst({where:{tenantId,status:{not:'CANCELLED'},periodStart:{lte:new Date(data.periodEnd)},periodEnd:{gte:new Date(data.periodStart)}}});
    if(existing) throw payrollError('Payroll run already exists for the specified period');
    return tx.payrollRun.create({data:{tenantId,periodStart:new Date(data.periodStart),periodEnd:new Date(data.periodEnd),countryCode:data.countryCode,currencyCode:data.currencyCode,status:'PENDING'}});
  },{tenantId});

  await logAction({
    employeeId: Number(createdBy),
    type: "Create",
    module: "Payroll Run",
    result: "SUCCESS",
    notes: `Payroll run "${create.id}" created successfully`,
    tenantId: tenantId ?? null,
  });

  return create;
};

// N-14 — which loans feed a run's deduction bridge. `outstanding > 0` alone
// drops a loan that THIS VERY RUN already repaid (Hakim Ali's 10K advance:
// recovered by August run 9, outstanding hit 0, and the re-process would
// silently drop the deduction line and raise his net). A loan with an existing
// repayment for THIS run stays selected — planLoanRepayment then re-prices the
// line without re-booking the ledger. Loans repaid by a DIFFERENT run (or
// manually) do not resurface.
export const loanBridgeWhere = (employeeId, payrollRunId) => ({
    employeeId,
    OR: [
        { status:'ACTIVE', outstandingMinor: { gt: 0 } },
        { repayments: { some: { payrollRunId } } },
    ],
});

// Statuses a run may be (re-)processed FROM. PENDING is the first run; COMPLETED
// and FAILED allow an idempotent re-process (no doubled payslips). PROCESSING
// prevents concurrent processing. APPROVED/FINALIZED/CANCELLED are
// terminal-ish and must NOT be silently re-computed.
const PROCESSABLE_STATUSES = new Set(['PENDING', 'COMPLETED', 'FAILED', 'REJECTED']);
// D-11: calculation commits each employee separately, so a crash or restart can
// leave a run in PROCESSING with no live request behind it. Once it has been
// untouched for PAYROLL_PROCESSING_STALE_MINUTES (default 30) it may be
// recalculated or cancelled again; a fresh PROCESSING run stays locked.
export const processingStaleMinutes = () => {
    const minutes = Number(process.env.PAYROLL_PROCESSING_STALE_MINUTES);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
};
export const isStaleProcessing = (run, now = Date.now()) =>
    run?.status === 'PROCESSING' && run.updated_at != null &&
    now - new Date(run.updated_at).getTime() >= processingStaleMinutes() * 60_000;

// N-10 — the payroll-eligible employee filter for a run. payroll_included is
// the documented payroll switch (hr.service.js:508; the attendance writer and
// reconciliation both honor it) — an administrative/operator employee must
// never land in a payslip just because their status is Active. The
// active/period-overlap OR is unchanged: case-insensitive on purpose (73 of 75
// production rows spell it "Active") and leavers keep the days they worked.
export const payrollEligibleFilter = (payrollRun) => ({
    AND: [
        { payroll_included: { not: false } },
        // Active is not evidence of employment in this pay period. Explicit
        // spells take precedence; otherwise use hire date, then joining date.
        { OR: [
            { employmentPeriods: { some: { startDate: { lte: payrollRun.periodEnd }, OR: [{endDate:null},{endDate:{gte:payrollRun.periodStart}}] } } },
            { employmentPeriods: { none: {} }, OR: [
                { hire_date: { lte: payrollRun.periodEnd } },
                { hire_date: null, joining_date: { lte: payrollRun.periodEnd } },
                { hire_date: null, joining_date: null },
            ] },
        ] },
        {
            OR: [
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
    ],
});

// N-15 — SALARY DEDUP GUARD (operator law 2026-09-11): the contractual Basic
// (45% of package) lives in employment_terms.baseSalary, and four tenants ALSO
// carried it as a BASIC earning assignment — the engine paid both and salaries
// came out at 145% of package. When the employee has employment terms, the base
// comes from the terms, so an earning assignment that duplicates it is dropped
// before the engine sees it. HomeVision (terms-only, the correct pattern) is
// untouched; a tenant with NO terms row keeps its assignments — the guard keys
// on the terms, not on the code. Deduction assignments are never touched.
export const BASE_DUPLICATE_CODES = new Set(['BASIC', 'BASE_SALARY']);
export const dedupeBaseSalaryAssignments = (employee) => {
    if (!employee?.employmentTerms?.length || !employee?.payrollAssignments?.length) return 0;
    const before = employee.payrollAssignments.length;
    employee.payrollAssignments = employee.payrollAssignments.filter(
        (a) => !(a.earningType && BASE_DUPLICATE_CODES.has(a.earningType.code)),
    );
    return before - employee.payrollAssignments.length;
};

// N-16 — EMPLOYMENT-SCOPED ATTENDANCE (Obaid/Meesam, 2026-09-11): the absence
// bridge prices every attendance row in the period, but days outside an
// employment spell are not "unexcused work" — a terminated employee (Obaid,
// out 2026-09-08) must not be docked for Sep 9+ no-punch days, and a re-hire
// (Meesam, back 2026-09-04) must not be docked for the gap between spells.
// Rows are kept only inside SOME spell (an open spell runs to `periodEnd`);
// earnings remain governed by computeProrationFactor. Employees with no period
// history (the steady-state majority) are untouched — scoping them to an empty
// spell list would zero their attendance.
export const scopeAttendanceToEmployment = (employee, periodEnd) => {
    const spells = (employee?.employmentPeriods || []).map((p) => ({
        start: p.startDate,
        end: p.endDate ?? null,
    }));
    if (!spells.length || !employee?.attendance?.length) return 0;
    const before = employee.attendance.length;
    employee.attendance = employee.attendance.filter((row) =>
        spells.some((s) => row.date >= s.start && row.date <= (s.end ?? periodEnd)),
    );
    return before - employee.attendance.length;
};

export const processPayrollRun = async (id, updatedBy, tenantId, options = {}) => {
    const preview = options.preview === true;
    const payrollRun = await prisma.payrollRun.findFirst({
        where: withTenant(tenantId, { id }),
        include: {
            payslips: true
        }
    });

    if (!payrollRun) {
        throw payrollError('Payroll run not found',404);
    }

    if (!preview && !PROCESSABLE_STATUSES.has(payrollRun.status) && !isStaleProcessing(payrollRun)) {
        throw payrollError(`Payroll run cannot be processed from ${payrollRun.status} status`);
    }

    // TS-SUBMIT-01 (operator item 3, 2026-09-17) — submitting the timesheet is
    // a MANDATORY BLOCKER: payroll cannot be initiated for the month until HR
    // has submitted the timesheet (the gatekeeper enforces lock + zero
    // unresolved anomalies, then activates the vault run). Every run created
    // BY the gatekeeper carries the submission audit row, so a run whose month
    // has no submission was created out-of-band — refuse it.
    if (!preview) {
        const month = `${payrollRun.periodStart.getUTCFullYear()}-${String(payrollRun.periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
        const submission = await prisma.payrollAuditLog.findFirst({
            where: withTenant(tenantId, {
                action: 'TIMESHEET_SUBMITTED',
                details: { contains: month },
            }),
            select: { id: true },
        });
        if (!submission) {
            throw payrollError(`HR-TP-03 timesheet for ${month} has not been submitted — submit the timesheet before running payroll (operator workflow 2026-09-17)`);
        }
    }

    // Update status to PROCESSING (scoped: updateMany so the tenant predicate
    // applies — a cross-tenant id would touch zero rows). Stamp processedBy so
    // the approver can be enforced as a DISTINCT employee at finalize time.
    if (!preview) await tenantTransaction(prisma,async tx=>{
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':approval-source:PAYROLL:' + id},0))`;
        await tx.$queryRaw`SELECT id FROM payroll_runs WHERE id=${id} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
        const current=await tx.payrollRun.findFirst({where:{tenantId,id}});
        const interrupted=isStaleProcessing(current);
        if(!PROCESSABLE_STATUSES.has(current?.status) && !interrupted) throw payrollError('Payroll changed or is already processing; refresh');
        const approval=await tx.hrApprovalRequest.findUnique({where:{tenantId_kind_sourceRef:{tenantId,kind:'PAYROLL',sourceRef:String(id)}}});
        if(approval && !['INITIATOR','REJECTED'].includes(approval.stage)) throw payrollError('Return the payroll to its initiator before recalculation');
        const actor=await tx.employee.findFirst({where:{tenant_id:tenantId,id:toInt(updatedBy) ?? -1}});
        if(!actor?.employee_code) throw payrollError('A verified employee code is required to process payroll');
        if(approval && approval.employeeCode!==actor.employee_code) throw payrollError('The payroll initiator must perform the recalculation');
        if(interrupted) await tx.payrollAuditLog.create({data:{tenantId,payrollRunId:id,action:'PAYROLL_PROCESSING_INTERRUPTED',details:`Recalculating a run left in PROCESSING since ${new Date(current.updated_at).toISOString()}`,employeeId:actor.id}});
        await tx.payrollRun.update({where:{id},data:{status:'PROCESSING',processedBy:actor.id,approvedBy:null,approvedAt:null}});
    },{tenantId});

    try {
        // Get all active employees for this tenant
        const employees = await prisma.employee.findMany({
            // HR-PAYROLL-EMPLOYMENT-PERIOD-01 — `status: 'active'` alone is a
            // cliff for leavers: deactivating someone who left mid-month drops
            // them from the run entirely and they lose the days they DID work.
            // Anyone with an employment period touching this run is included and
            // then prorated to the days it covers.
            // N-10 — payroll_included is the documented payroll filter
            // (hr.service.js:508); the selection must honor it like the
            // attendance writer and reconciliation do.
            where: {
                tenant_id: tenantId ?? null,
                ...payrollEligibleFilter(payrollRun),
            },
            include: {
                // Every spell touching the run. computeProrationFactor clips and
                // merges them, so a re-hire is simply two rows.
                employmentPeriods: {
                    // Every spell that STARTED by the end of this run, including
                    // ones that already closed. Filtering to overlapping spells
                    // only leaves a leaver with an EMPTY list, and an empty list
                    // means "no history on file", which pays a full month — the
                    // exact bug employment periods exist to prevent. Let
                    // computeProrationFactor score a past spell as zero.
                    where: { startDate: { lte: payrollRun.periodEnd } },
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
                    // N-01 — day_credit added: the absence bridge prices
                    // Σ(1 − credit). NULL credit (MISSING_*) stays held.
                    select: { date: true, status: true, day_credit: true, manually_corrected: true, check_in:true, check_out:true }
                },
                attendanceAnomalies: {
                    where: {
                        date: {
                            gte: payrollRun.periodStart,
                            lte: payrollRun.periodEnd
                        }
                    },
                    select: { id: true, date: true, status: true, type: true, manualDeductionDays: true, expectedTime:true, actualTime:true, rulesVersion:true, sessionKey:true, measuredMinutes:true, decisionRole:true, evidenceState:true, employeeId:true }
                }
            }
        });

        // Remove only unapproved, undistributed, zero-value leftovers for
        // employees who no longer qualify for this period. Keep a full audit.
        if (!preview) await tenantTransaction(prisma, async tx => {
            const stale=await tx.payrollPayslip.findMany({where:withTenant(tenantId,{payrollRunId:id,employeeId:{notIn:employees.map(e=>e.id)}}),include:{earnings:true,deductions:true}});
            for(const slip of stale) {
                if(slip.status!=='DRAFT'||slip.distributedAt||[slip.grossAmount,slip.totalDeductions,slip.netAmount].some(n=>Number(n)!==0)||await tx.loanRepayment.count({where:{payslipId:slip.id}})) throw payrollError('An ineligible employee has a protected or nonzero payslip; review employee setup before recalculation');
                await tx.payrollAuditLog.create({data:{tenantId,action:'INELIGIBLE_ZERO_PAYSLIP_REMOVED',payrollRunId:id,employeeId:slip.employeeId,details:'Employee was not employed in this payroll period. Removed only an undistributed DRAFT payslip with all totals zero.',oldValues:JSON.parse(JSON.stringify(slip))}});
                await tx.payrollPayslip.delete({where:{id:slip.id}});
            }
        });

        // Read both current and legacy leave stores. An approved leave must
        // excuse attendance even if device roll-up has not marked ON_LEAVE yet.
        const [approvedRequests, approvedLegacyLeaves] = await Promise.all([
            prisma.leaveRequest.findMany({where:withTenant(tenantId,{status:'APPROVED',startDate:{lte:payrollRun.periodEnd},endDate:{gte:payrollRun.periodStart}}),select:{employeeId:true,status:true,startDate:true,endDate:true}}),
            prisma.leave.findMany({where:withTenant(tenantId,{status:'APPROVED',start_date:{lte:payrollRun.periodEnd},end_date:{gte:payrollRun.periodStart}}),select:{employeeId:true,status:true,start_date:true,end_date:true}}),
        ]);
        const leaveCoverage=approvedLeaveCoverage([...approvedRequests,...approvedLegacyLeaves],payrollRun.periodStart,payrollRun.periodEnd);
        for(const employee of employees) employee.attendanceAnomalies.push(...leaveCoverage.filter(a=>a.employeeId===employee.id));

        // An explicitly authorized, run-specific attendance snapshot can be
        // shared by a person paid by two companies. Raw attendance is retained
        // in its owning company; no approval decisions are manufactured.
        const attendanceSnapshots=await prisma.payrollAuditLog.findMany({where:withTenant(tenantId,{payrollRunId:id,action:'PAYROLL_ATTENDANCE_SOURCE_SNAPSHOT'}),orderBy:[{created_at:'desc'},{id:'desc'}],distinct:['employeeId']});
        for(const audit of attendanceSnapshots) {
            const employee=employees.find(e=>e.id===audit.employeeId);if(!employee)continue;
            const snapshot=audit.newValues;
            if(snapshot?.periodStart!==payrollRun.periodStart.toISOString().slice(0,10)||snapshot?.periodEnd!==payrollRun.periodEnd.toISOString().slice(0,10)||!Array.isArray(snapshot?.attendance)||!Array.isArray(snapshot?.anomalies)) throw payrollError('Attendance snapshot does not match payroll period');
            const restore=rows=>rows.map(row=>{const date=new Date(row.date);if(!Number.isFinite(date.getTime())||date<payrollRun.periodStart||date>payrollRun.periodEnd)throw payrollError('Attendance snapshot contains an out-of-period date');return {...row,date};});
            employee.attendance=restore(snapshot.attendance);
            // Decisions always come from current, tenant-scoped cases; legacy
            // day-level snapshots cannot waive or introduce rule deductions.
            employee.payrollTimingFromSnapshot=true;
        }

        const nilTaxEstimates=await prisma.payrollAuditLog.findMany({where:withTenant(tenantId,{payrollRunId:id,action:'PAYROLL_NIL_TAX_ESTIMATE'}),orderBy:[{created_at:'desc'},{id:'desc'}],distinct:['employeeId']});
        for(const audit of nilTaxEstimates){const employee=employees.find(e=>e.id===audit.employeeId);if(employee)employee.payrollNilTaxEstimate=audit.newValues;}

        const monthlyInputs = employees.some(isHeadendEmployee) ? await prisma.monthlyPayrollAttendance.findMany({where:{tenantId,month:payrollRun.periodStart.toISOString().slice(0,7)}}) : [];
        const monthlyByEmployee = new Map(monthlyInputs.map(row=>[row.employeeId,row]));
        // N-15 / N-16 — salary dedup + employment-scoped attendance, applied to
        // every selected employee before the payslip build (helpers above).
        for (const employee of employees) {
            employee.attendanceInputMode = isHeadendEmployee(employee) ? 'MANUAL_MONTHLY' : 'DEVICE';
            dedupeBaseSalaryAssignments(employee);
            scopeAttendanceToEmployment(employee, payrollRun.periodEnd);
        }

        // Published setup supplies employee calendars and shift coverage;
        // Management decisions supply the fixed anomaly deduction rules.
        const attendanceRuntime=await loadAttendanceRuntime({tenantId,from:payrollRun.periodStart,to:payrollRun.periodEnd});
        const periodDays=dateRange(payrollRun.periodStart,payrollRun.periodEnd);
        for(const day of periodDays) {
            if(!attendanceRuntime.configOn(day)) throw badSetup('Publish attendance setup covering this payroll period',409);
        }
        for(const employee of employees) {
            const modes=new Set();
            for(const day of periodDays) {
                if(!employedOn(employee,employee.employmentPeriods||[],day))continue;
                const info=attendanceRuntime.resolve(employee.id,day);
                if(info.working==null)throw badSetup('Complete attendance setup for '+employeeCode(employee)+' on '+day,409);
                modes.add(info.profile?.mode);
            }
            if(modes.size>1)throw badSetup('Attendance input mode changes inside the payroll period for '+employeeCode(employee),409);
            if(modes.size)employee.attendanceInputMode=[...modes][0];
        }


        // HR-PAYROLL-EOBI-01 — per-tenant statutory switches, read once for the
        // run. Absent row means the tenant never configured payroll rules, which
        // is the same as everything off.
        const readiness = await payrollReadiness({tenantId,run:{...payrollRun,calculationConfigVersion:null},employees});
        assertReady(readiness.issues);
        const config = readiness.snapshot.config;
        const ruleConfig = config.payRules || {};
        const components = config.salaryComponents || [];

        // HR-02 — read the VERSIONED tax snapshot ONCE for the run's country,
        // effective at the run's period end. selectEffectiveTaxRates ignores
        // future-dated and foreign-country rows; computeRuleVersion records the
        // exact rule the run is computed against so it is reproducible.
        const allCountryRates = config.taxSlabs || [];
        const ratesEffectiveAt = payrollRun.periodEnd;
        const effectiveRates = selectEffectiveTaxRates(allCountryRates, {
            countryCode: payrollRun.countryCode,
            asOf: ratesEffectiveAt
        });
        const ruleVersion = computeRuleVersion(effectiveRates, ratesEffectiveAt);
        // The anomaly-deduction rules this run is priced with; a copy is kept with the
        // run (not for a preview) so the pricing can be audited later.
        const deductionRules = await loadDeductionRules(tenantId);
        if (!preview) await snapshotDeductionRules(prisma, { tenantId, runId: id, rules: deductionRules, actorId: updatedBy });

        // Resolve the persisted type ids the pure engine leaves null (base
        // salary earning) once per run.
        const baseSalaryEarningTypeId = preview ? null : await getBaseSalaryEarningTypeId(tenantId);

        // HR-PAYROLL-DEDUCTION-TYPE-01 — code → PayrollDeductionType, resolved
        // ONCE per run and LAZILY: a tenant that never emits an EOBI line never
        // gets an EOBI type row. Cache the PROMISE, not the id, so the parallel
        // per-employee map below cannot race two creates for the same code.
        const deductionTypeIds = new Map();
        const resolveDeductionTypeId = (code) => {
            const name = DEDUCTION_TYPE_NAMES[code] || components.find(c=>c.code===code && c.type==='DEDUCTION')?.name;
            // No silent fallback. A line reaching persistence with no resolvable
            // type is a bug in whichever bridge emitted it — recording it as
            // income tax is how this finding happened in the first place.
            if (!name) throw payrollError(`HR-PAYROLL-DEDUCTION-TYPE-01: deduction line has no resolvable deduction type (code=${code ?? 'none'})`);
            if (!deductionTypeIds.has(code)) {
                deductionTypeIds.set(code, getOrCreateDeductionType(code, name, tenantId));
            }
            return deductionTypeIds.get(code);
        };

        // One tenant-wide financial lock serializes these writes. Do not fill the
        // connection pool with waiting transactions while type lookups need a connection.
        const payslips = [];
        for (const employee of employees.filter(e=>!options.employeeCode || e.employee_code===options.employeeCode)) payslips.push(await tenantTransaction(prisma, async (tx) => {
            const prisma = tx;
            await lockAttendancePeriod(tx, tenantId, true);
            const reservingRuns=await prisma.payrollRun.findMany({where:{tenantId,status:{notIn:['FAILED','CANCELLED']}},select:{id:true}});
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
                    select: { totalDays: true, startDate:true,endDate:true, leavePolicy: { select: { leaveTypeCode: true } } },
                }),
                // Active benefit enrollments with plan details
                prisma.employeeBenefit.findMany({
                    where: withTenant(tenantId, {
                        employeeId: employee.id,
                        status: "ACTIVE",
                    }),
                    include: { benefitPlan: { select: { name: true, employerContributionMinor: true, employeeContributionMinor: true } } },
                }),
                // Active loans with outstanding balance — or ones this run
                // already repaid (N-14): re-processing must keep their
                // deduction line, never silently re-pay the installment.
                prisma.loan.findMany({
                    where: withTenant(tenantId, loanBridgeWhere(employee.id, payrollRun.id)),
                    select: { id: true, kind:true, monthlyInstallmentMinor: true, outstandingMinor: true, repayments:{where:{OR:[{payrollRunId:id},{settledAt:null,payrollRunId:{in:reservingRuns.map(r=>r.id)}}]}} },
                }),
            ]);

            // Build bridge data
            const previousSlip=await prisma.payrollPayslip.findFirst({where:{tenantId,payrollRunId:id,employeeId:employee.id}});
            if (!preview) await releaseFailedCarry(prisma,{tenantId,employeeId:employee.id});
            const attendanceAdjustments=await prisma.attendancePayrollAdjustment.findMany({where:{tenantId,employeeId:employee.id,currencyCode:currency,sourcePeriodEnd:{lt:payrollRun.periodStart},OR:[{appliedPayslipId:null},...(previousSlip?[{appliedPayslipId:previousSlip.id}]:[])]}});
            const bridges = {
                deductionRules,
                attendanceAdjustments,
                manualAttendance: monthlyByEmployee.get(employee.id),
                overtimeLines: overtimeRequests.map(ot => ({
                    date: ot.date?.toISOString().split('T')[0],
                    hours: ot.hours,
                    rate: ot.rate,
                })),
                lwpDays: unpaidLeaves
                    .filter(l => l.leavePolicy?.leaveTypeCode === 'UNPAID' || l.leavePolicy?.leaveTypeCode === 'LWP')
                    .reduce((sum, l) => { const span=Math.round((new Date(l.endDate)-new Date(l.startDate))/86400000)+1; const overlap=Math.max(0,Math.round((Math.min(+l.endDate,+payrollRun.periodEnd)-Math.max(+l.startDate,+payrollRun.periodStart))/86400000)+1); return sum+(l.totalDays||0)*overlap/span; }, 0),
                benefitLines: employeeBenefits.map(eb => ({
                    planName: eb.benefitPlan?.name,
                    employerContributionMinor: eb.benefitPlan?.employerContributionMinor || 0,
                    employeeContributionMinor: eb.electedAmountMinor || eb.benefitPlan?.employeeContributionMinor || 0,
                })),
                loanLines: activeLoans.map(loan => {
                    const outstandingMinor=Math.max(0,loan.outstandingMinor + loan.repayments.filter(r=>r.settledAt && r.payrollRunId===id).reduce((sum,r)=>sum+r.amountMinor,0) - loan.repayments.filter(r=>!r.settledAt && r.payrollRunId!==id).reduce((sum,r)=>sum+r.amountMinor,0));
                    return {
                        loanId: loan.id,
                        name: loan.kind==='ADVANCE' ? 'Salary advance repayment' : 'Loan repayment',
                        amountMinor: Math.min(loan.monthlyInstallmentMinor, outstandingMinor),
                        outstandingMinor,
                    };
                }),
                attendanceRows: employee.attendance || [],
                anomalyRows: employee.attendanceAnomalies || [],
            };

            // Build the canonical payslip with the REAL, deterministic engine.
            const built = buildPayslipFromInputs({
                employee,
                employmentTerm,
                assignments: payrollAssignments({employee,employmentTerm,assignments:employee.payrollAssignments,components,payrollRun}),
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
            if (Number(built.netAmount) < 0) throw payrollError(`Negative net pay for ${employeeCode(employee)}; resolve deductions before processing`);
            if (preview) return {...built,employeeCode:employeeCode(employee)};
            const earnings = await Promise.all(built.earnings.map(async (e) => ({
                tenantId: tenantId ?? null,
                earningTypeId: e.earningTypeId ?? (e.code ? await getOrCreateEarningType(e.code,e.description,e.taxable,tenantId) : baseSalaryEarningTypeId),
                amount: e.amount,
                description: e.description
            })));
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
                        payrollOffice: employee.payrollOffice,
                        attendanceInputMode: employee.attendanceInputMode || 'DEVICE',
                        payableDays: built.payableDays,
                        attendanceBasisMinor:built.attendanceBasisMinor,attendancePeriodDays:built.attendancePeriodDays,
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
                // Record loan repayments for this payslip (T-1.2 — idempotent:
                // a repayment already recorded for [loan, run] is never
                // re-created or re-decremented on re-process).
                await reservePayrollLoans(prisma,{tenantId,runId:id,payslipId:updated.id,deductions:built.deductions,currency});
                await prisma.payrollAuditLog.create({
                    data: {
                        tenantId: tenantId ?? null,
                        action: 'PAYSLIP_REPROCESSED',
                        details: `Payslip re-processed for ${employeeCode(employee)}`,
                        payrollRunId: id,
                        payslipId: updated.id,
                        employeeId: employee.id,
                        oldValues: { grossAmount: existing.grossAmount, totalDeductions: existing.totalDeductions, netAmount: existing.netAmount },
                        newValues: { grossAmount: built.grossAmount, totalDeductions: built.totalDeductions, netAmount: built.netAmount, prorationFactor: built.prorationFactor },
                    },
                });
                await prisma.attendancePayrollAdjustment.updateMany({where:{tenantId,id:{in:attendanceAdjustments.map(a=>a.id)}},data:{appliedPayslipId:updated.id}});
                return updated;
            }

            const created = await prisma.payrollPayslip.create({
                data: {
                    tenantId: tenantId ?? null,
                    payrollRunId: id,
                    employeeId: employee.id,
                    payrollOffice: employee.payrollOffice,
                    attendanceInputMode: employee.attendanceInputMode || 'DEVICE',
                    payableDays: built.payableDays,
                    attendanceBasisMinor:built.attendanceBasisMinor,attendancePeriodDays:built.attendancePeriodDays,
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
            // Record loan repayments for this payslip (T-1.2 — idempotent by
            // [loan, run]; see the re-process branch above for the contract).
            await reservePayrollLoans(prisma,{tenantId,runId:id,payslipId:created.id,deductions:built.deductions,currency});
            await prisma.payrollAuditLog.create({
                data: {
                    tenantId: tenantId ?? null,
                    action: 'PAYSLIP_CREATED',
                    details: `Payslip created for ${employeeCode(employee)}`,
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
            await prisma.attendancePayrollAdjustment.updateMany({where:{tenantId,id:{in:attendanceAdjustments.map(a=>a.id)}},data:{appliedPayslipId:created.id}});
            return created;
        }, {tenantId,txOptions:{timeout:60000,maxWait:120000}}));



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
        if (preview) {
            if (options.employeeCode && !payslips.length) throw payrollError('Employee code is not eligible in this payroll');
            return {runId:id,configVersion:readiness.snapshot.version,payslips,totalGross,totalDeductions,totalNet};
        }
        await prisma.payrollRun.updateMany({
            where: withTenant(tenantId, { id }),
            data: {
                calculationConfigVersion:readiness.snapshot.version,
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

        // A rejected calculation starts a new, fully audited review round.
        await tenantTransaction(prisma, async tx=>{
          const row=await tx.hrApprovalRequest.findUnique({where:{tenantId_kind_sourceRef:{tenantId,kind:'PAYROLL',sourceRef:String(id)}}});
          if(row?.stage==='REJECTED'){
            const next=await tx.hrApprovalRequest.update({where:{id:row.id},data:{stage:'INITIATOR',version:{increment:1},execution:'PENDING',recommendation:null,verification:null,managerActorCode:null,hrActorCode:null}});
            await tx.hrApprovalAudit.create({data:{tenantId,approvalRef:row.id,version:next.version,round:row.round,actorCode:row.employeeCode,fromStage:'REJECTED',toStage:'INITIATOR',action:'RECALCULATE',reason:'Rejected payroll recalculated; full review required',sourceHash:row.sourceHash}});
          }
        },{tenantId});
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
        if (!preview) await prisma.payrollRun.updateMany({
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

const getOrCreateEarningType = async (code,name,taxable,tenantId) => {
  const row=await prisma.payrollEarningType.upsert({where:{tenantId_code:{tenantId,code}},create:{tenantId,code,name,isTaxable:taxable!==false},update:{}});
  return row.id;
};
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

// HR-PAY-REJECT-01 — Rejecting a processed batch is a distinct, auditable
// state transition. It must not delete the run or silently turn it into a
// cancellation: HR needs the rejected batch and reason for correction/review.
export const rejectPayrollRun = async (id, rejectedBy, reason, tenantId) => {
  return legacyDecision('PAYROLL',id);
};

// HR-02 / T-P4.1 — APPROVAL GATE with separation of duties.
//
// A COMPLETED run must be APPROVED by a human who is DISTINCT from the employee
// that processed it before it can be FINALIZED. approvePayrollRun records the
// approver (must differ from processedBy — no self-approval) and moves the run
// to APPROVED. finalizePayrollRun then requires status===APPROVED with a
// recorded approver. The check compares integer employee ids.
export const approvePayrollRun = async (id, approverId, tenantId) => {
  return legacyDecision('PAYROLL',id);
};

export const finalizePayrollRun = async (id, updatedBy, tenantId, ctx = {}) => {
  const payrollRun = await prisma.payrollRun.findFirst({ where: withTenant(tenantId, { id }) });
  if (!payrollRun) throw payrollError('Payroll run not found',404);

  // Approval gate: a run is only finalizable once it has been APPROVED by a
  // distinct approver. A COMPLETED-but-unapproved run is blocked here. A replay
  // of a finalize that already succeeded returns the run before the If-Match
  // check, so a retry after a lost response does not read as a conflict.
  if (payrollRun.status === 'FINALIZED') return getPayrollRunById(id,tenantId);

  // X-07 — If-Match / 412 optimistic concurrency (opt-in via ctx.ifMatch). A
  // finalize racing a concurrent re-process/approve is rejected, not clobbered;
  // it is checked again on the locked row below.
  assertIfMatch(ctx.ifMatch, payrollRun);
  if (payrollRun.status !== 'APPROVED') {
    throw payrollError('HR-2012 payroll run requires approval before it can be finalized');
  }
  if (payrollRun.approvedBy == null) {
    throw payrollError('HR-2012 payroll run requires approval before it can be finalized');
  }
  // Defence in depth: re-assert separation of duties at finalize time too, in
  // case the approval row was tampered with.
  if (payrollRun.processedBy != null && payrollRun.approvedBy === payrollRun.processedBy) {
    throw payrollError('HR-2011 self-approval forbidden: the approver must be distinct from the processor');
  }

  // M1-HR: the payslip + run FINALIZED flips, the audit row, and the
  // hr.payroll.run_finalized.v1 outbox event commit or roll back together
  // (outbox-on-write, validate-before-write). The event is ids-only +
  // tenant-scoped from the run's verified tenant.
  await tenantTransaction(prisma, async (tx) => {
    await lockAttendancePeriod(tx,tenantId,true);
    await tx.$queryRaw`SELECT id FROM payroll_runs WHERE id=${id} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
    const locked=await tx.payrollRun.findFirst({where:{id,tenantId}});
    if(locked.status==='FINALIZED') return;
    assertIfMatch(ctx.ifMatch, locked);
    if(locked.status!=='APPROVED') throw payrollError('Payroll approval is required');
    const approval=await tx.hrApprovalRequest.findUnique({where:{tenantId_kind_sourceRef:{tenantId,kind:'PAYROLL',sourceRef:String(id)}}});
    const source=await loadSource(tx,{tenantId},'PAYROLL',String(id),{pending:false});
    if(approval?.stage!=='APPROVED'||approval.sourceHash!==source.digest) throw payrollError('Complete HR Approval Centre review of the current payroll');
    const employees=await tx.employee.findMany({where:{tenant_id:tenantId,payrollPayslips:{some:{payrollRunId:id}}},include:{employmentTerms:{where:{tenantId,effectiveFrom:{lte:locked.periodEnd},OR:[{effectiveTo:null},{effectiveTo:{gte:locked.periodStart}}]},orderBy:{effectiveFrom:'desc'},take:1}}});
    assertReady((await payrollReadiness({tenantId,run:locked,employees,db:tx})).issues);
    const holds=await tx.payrollPayslip.count({where:{tenantId,payrollRunId:id,status:'HOLD'}});
    if(holds) throw payrollError('Resolve held payslips before finalization');
    await settlePayrollLoans(tx,{tenantId,runId:id});
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
        details: 'Payroll finalized after HR Approval Centre approval',
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
    notes: `Payroll run "${id}" finalized successfully`,
    tenantId: tenantId ?? null,
  });

  return getPayrollRunById(id, tenantId);
};
export const cancelPayrollRun = async (id, deletedBy, tenantId) => tenantTransaction(prisma,async tx=>{
  await lockAttendancePeriod(tx,tenantId,true);
  await tx.$queryRaw`SELECT id FROM payroll_runs WHERE id=${id} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
  const run=await tx.payrollRun.findFirst({where:{id,tenantId}});
  if(!run) throw payrollError('Payroll run not found',404);
  if(!['PENDING','FAILED','REJECTED'].includes(run.status) && !isStaleProcessing(run)) throw payrollError('Only pending, failed, interrupted or Management-rejected payroll may be cancelled');
  if(await tx.loanRepayment.count({where:{tenantId,payrollRunId:id,settledAt:{not:null}}})) throw Object.assign(new Error('Reconcile posted loan repayments before cancelling this historical payroll'),{status:409});
  // A submitted run carries an approval request; the source guard trigger only
  // lets it reach CANCELLED once that request is WITHDRAWN in this transaction.
  const approval=await tx.hrApprovalRequest.findUnique({where:{tenantId_kind_sourceRef:{tenantId,kind:'PAYROLL',sourceRef:String(id)}}});
  if(approval){
    if(!['INITIATOR','REJECTED'].includes(approval.stage)) throw Object.assign(new Error('Return the payroll to its initiator before cancelling'),{status:409});
    const actor=await tx.employee.findFirst({where:{tenant_id:tenantId,id:toInt(deletedBy) ?? -1}});
    if(!actor?.employee_code) throw Object.assign(new Error('A verified employee code is required to cancel submitted payroll'),{status:403});
    const withdrawn=await tx.hrApprovalRequest.update({where:{id:approval.id},data:{stage:'WITHDRAWN',execution:'APPLIED',version:{increment:1}}});
    await tx.hrApprovalAudit.create({data:{tenantId,approvalRef:approval.id,version:withdrawn.version,round:withdrawn.round,actorCode:actor.employee_code,fromStage:approval.stage,toStage:'WITHDRAWN',action:'WITHDRAW',reason:'Payroll run cancelled',sourceHash:withdrawn.sourceHash}});
    await tx.$executeRaw`SELECT set_config('app.hr_approval_finalizing',${'PAYROLL:'+id},true)`;
  }
  await tx.loanRepayment.deleteMany({where:{tenantId,payrollRunId:id,settledAt:null}});
  await tx.payrollRun.update({where:{id},data:{status:'CANCELLED'}});
  await tx.payrollAuditLog.create({data:{tenantId,payrollRunId:id,action:'PAYROLL_CANCELLED',details:'Cancelled without deleting payroll history',employeeId:toInt(deletedBy)}});
  return {id,status:'CANCELLED'};
},{tenantId});

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
    notes: `Earning Type "${create.name}" created`,
    tenantId: tenantId ?? null,
  });

  return create;
};


export const updateEarningType = async (id, data, updatedBy, tenantId) => {
  // Ownership check then scoped update; a cross-tenant id is not-found.
  const existing = await prisma.payrollEarningType.findFirst({ where: withTenant(tenantId, { id }) });
  if (!existing) throw payrollError('Earning type not found');

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
    notes: `Earning Type "${update.name}" updated`,
    tenantId: tenantId ?? null,
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
    notes: `Deduction Type "${create.name}" created`,
    tenantId: tenantId ?? null,
  });

  return create;
};

export const updateDeductionType = async (id, data, updatedBy, tenantId) => {
  const existing = await prisma.payrollDeductionType.findFirst({ where: withTenant(tenantId, { id }) });
  if (!existing) throw payrollError('Deduction type not found');

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
    notes: `Deduction Type "${update.name}" updated`,
    tenantId: tenantId ?? null,
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
    notes: `Employment terms created for employee ID: ${create.employeeId || "N/A"}`,
    tenantId: tenantId ?? null,
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
    notes: `Payroll assignment created for employee ID: ${create.employeeId} (EarningType: ${create.earningTypeId || "N/A"}, DeductionType: ${create.deductionTypeId || "N/A"})`,
    tenantId: tenantId ?? null,
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
                    select: { id: true, employee_code: true, job_title: true }
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
                    employee_code: true,
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
    throw payrollError("Payslip not found");
  }

  if (payslip.status !== "FINALIZED") {
    throw payrollError("Only finalized payslips can be distributed");
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
    notes: `Payslip (ID: ${id}) distributed to employee ID: ${payslip.employeeId}`,
    tenantId: tenantId ?? null,
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
    notes: `Tax rate for country "${create.countryCode}" and bracket "${create.bracketMin} - ${create.bracketMax}" created successfully`,
    tenantId: tenantId ?? null,
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
                    select: { id: true, employee_code: true }
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
    rejectPayrollRun,
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
