// src/services/taxFormService.js — HR-PAY-07 / HR-SEC-05 (statutory year-end forms)
//
// Generate the statutory year-end tax artifacts for a TAX YEAR, computed from
// that year's FINALIZED payroll runs + the employee/contractor records:
//   * W-2  (Wage & Tax Statement)        — one per EMPLOYEE.
//   * 1099-NEC (Nonemployee Compensation) — one per CONTRACTOR.
//
// Recipient split: an employee whose `employee_type` marks them a contractor
// (contract / 1099 / consultant / freelance / vendor) gets a 1099-NEC; everyone
// else gets a W-2. Amounts are aggregated across every FINALIZED run whose pay
// date (proxied by the run's periodEnd) falls inside the tax year. NON-FINALIZED
// runs are never included (the run query filters status === 'FINALIZED').
//
// SECURITY CONTRACT (the parts this module OWNS — mirrors bankFileService):
//   * Tenant scope — every query folds the VERIFIED tenant via withTenant /
//     scopedEmployeeWhere, so a cross-tenant request resolves to its own (often
//     empty) data, never another tenant's payroll. The controller/route also
//     deny-by-default permission-gates the surface (requirePermission hr:payroll).
//   * C4 decryption is IN-MEMORY ONLY — the recipient SSN/EIN lives in the
//     c4-encrypted Employee.nationality_id_no column and is transparently
//     decrypted by the prisma C4 extension on read. The plaintext identifier
//     appears ONLY inside the returned structured records / export `content`.
//     It is NEVER logged: structured logs and the audit row carry counts,
//     totals and a MASKED identifier (last-4) only — never the plaintext.
//
// Money is summed in INTEGER MINOR UNITS (cents) via src/lib/money.js so totals
// are exact, then converted back to a major-unit Number at the boundary.
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { logAction } from '../utils/logs.js';
import * as money from '../lib/money.js';
import { withTenant, scopedEmployeeWhere } from '../lib/tenancy.js';
import { TAX_FORM_FORMATTERS, isSupportedExport } from '../lib/taxFormFormats.js';

const fail = (status, code, message) =>
    Object.assign(new Error(message), { status, statusCode: status, code });

// last-4 masking for anything that touches a log/audit sink. Never emit the
// full SSN/EIN — only enough to correlate a form to a recipient.
export const maskTin = (tin) => {
    const s = String(tin ?? '').replace(/\D/g, '');
    if (s.length <= 4) return '****';
    return `****${s.slice(-4)}`;
};

const norm = (s) => String(s ?? '').toUpperCase();

// A recipient is a 1099 contractor when their employment type marks them so;
// otherwise they are a W-2 employee. Kept permissive on the contractor side and
// defaulting to W-2, so a missing/odd type is treated as an employee (safer for
// statutory wage reporting).
export const isContractor = (employee) =>
    /CONTRACT|1099|FREELANC|CONSULT|VENDOR/.test(norm(employee?.employee_type));

// Classify a deduction line into a statutory withholding bucket from its
// deduction TYPE (code first, then name). Order matters: the specific FICA
// buckets are tested before the generic federal-income-tax matcher so e.g.
// "Social Security Tax" is not miscounted as federal income tax. The payroll
// engine persists its computed income-tax line under the 'INCOME_TAX' type
// (payrollService.getOrCreateDeductionType('INCOME_TAX', 'Income Tax')).
export const classifyWithholding = (deductionType) => {
    const hay = `${norm(deductionType?.code)} ${norm(deductionType?.name)}`;
    if (/MEDICARE/.test(hay)) return 'medicare';
    if (/SOCIAL SECURITY|OASDI|\bFICA\b/.test(hay)) return 'socialSecurity';
    if (/STATE.*(TAX|WITHHOLD)|\bSIT\b/.test(hay)) return 'stateTax';
    if (
        norm(deductionType?.code) === 'INCOME_TAX'
        || /FEDERAL.*(TAX|WITHHOLD)|INCOME TAX|\bFIT\b|\bFWT\b|WITHHOLDING TAX/.test(hay)
    ) return 'federalTax';
    return 'other';
};

// An earning is taxable unless its type explicitly says otherwise.
const earningIsTaxable = (earning) => earning?.earningType?.isTaxable !== false;

const yearWindow = (taxYear) => ({
    start: new Date(Date.UTC(taxYear, 0, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(taxYear, 11, 31, 23, 59, 59, 999)),
});

const validateTaxYear = (taxYear) => {
    const y = Number(taxYear);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
        throw fail(400, 'HR-1400', `Invalid tax year '${taxYear}' (expected an integer 2000-2100)`);
    }
    return y;
};

// Per-recipient running accumulator in integer minor units (cents).
const newAccumulator = () => ({
    taxableWagesMinor: 0,
    grossPayMinor: 0,
    totalDeductionsMinor: 0,
    netPayMinor: 0,
    federalTaxMinor: 0,
    socialSecurityMinor: 0,
    medicareMinor: 0,
    stateTaxMinor: 0,
    payslipCount: 0,
    runIds: new Set(),
});

const accumulatePayslip = (acc, slip) => {
    acc.payslipCount += 1;
    acc.runIds.add(slip.payrollRunId);
    acc.grossPayMinor = money.add(acc.grossPayMinor, money.fromMajor(slip.grossAmount ?? 0));
    acc.totalDeductionsMinor = money.add(acc.totalDeductionsMinor, money.fromMajor(slip.totalDeductions ?? 0));
    acc.netPayMinor = money.add(acc.netPayMinor, money.fromMajor(slip.netAmount ?? 0));

    for (const earning of slip.earnings ?? []) {
        if (earningIsTaxable(earning)) {
            acc.taxableWagesMinor = money.add(acc.taxableWagesMinor, money.fromMajor(earning.amount ?? 0));
        }
    }

    for (const deduction of slip.deductions ?? []) {
        const amt = money.fromMajor(deduction.amount ?? 0);
        switch (classifyWithholding(deduction.deductionType)) {
            case 'federalTax': acc.federalTaxMinor = money.add(acc.federalTaxMinor, amt); break;
            case 'socialSecurity': acc.socialSecurityMinor = money.add(acc.socialSecurityMinor, amt); break;
            case 'medicare': acc.medicareMinor = money.add(acc.medicareMinor, amt); break;
            case 'stateTax': acc.stateTaxMinor = money.add(acc.stateTaxMinor, amt); break;
            default: break; // non-statutory deduction (benefit, loan, ...)
        }
    }
};

const recipientIdentity = (employee) => ({
    employeeId: employee?.id ?? null,
    employeeCode: employee?.employee_code ?? null,
    name:
        employee?.employee_name
        || [employee?.first_name, employee?.last_name].filter(Boolean).join(' ')
        || (employee?.id != null ? `EMP ${employee.id}` : null),
    firstName: employee?.first_name ?? null,
    lastName: employee?.last_name ?? null,
    // Decrypted in-memory by the prisma C4 extension; surfaced ONLY here.
    tin: employee?.nationality_id_no ?? null,
    tinType: employee?.nationality_id_type ?? null,
    address: {
        street: employee?.current_address ?? null,
        city: employee?.city ?? null,
        state: employee?.state ?? employee?.province ?? null,
        postalCode: employee?.postal_code ?? null,
        country: employee?.country ?? null,
    },
});

const payerOf = (tenantId, payer = {}) => ({
    name: payer.name ?? null,
    ein: payer.ein ?? null,
    address: payer.address ?? null,
    tenantId: tenantId ?? null,
});

const buildW2 = (taxYear, currency, employee, acc, payer) => ({
    formType: 'W-2',
    taxYear,
    currency,
    payer,
    recipient: recipientIdentity(employee),
    boxes: {
        box1_wagesTipsOtherComp: money.toMajor(acc.taxableWagesMinor),
        box2_federalIncomeTaxWithheld: money.toMajor(acc.federalTaxMinor),
        // SS/Medicare wage bases equal the taxable wage here; the SS annual wage
        // cap is an EXTENSION POINT (needs a per-year wage-base table).
        box3_socialSecurityWages: money.toMajor(acc.taxableWagesMinor),
        box4_socialSecurityTaxWithheld: money.toMajor(acc.socialSecurityMinor),
        box5_medicareWagesAndTips: money.toMajor(acc.taxableWagesMinor),
        box6_medicareTaxWithheld: money.toMajor(acc.medicareMinor),
        box16_stateWages: money.toMajor(acc.taxableWagesMinor),
        box17_stateIncomeTax: money.toMajor(acc.stateTaxMinor),
    },
    reconciliation: {
        grossPay: money.toMajor(acc.grossPayMinor),
        totalDeductions: money.toMajor(acc.totalDeductionsMinor),
        netPay: money.toMajor(acc.netPayMinor),
        payslipCount: acc.payslipCount,
        runIds: [...acc.runIds].sort((a, b) => a - b),
    },
});

const build1099 = (taxYear, currency, employee, acc, payer) => ({
    formType: '1099-NEC',
    taxYear,
    currency,
    payer,
    recipient: recipientIdentity(employee),
    boxes: {
        // Box 1 nonemployee compensation = total gross paid to the contractor.
        box1_nonemployeeCompensation: money.toMajor(acc.grossPayMinor),
        // Box 4 federal income tax withheld (backup withholding) — usually 0.
        box4_federalIncomeTaxWithheld: money.toMajor(acc.federalTaxMinor),
    },
    reconciliation: {
        grossPay: money.toMajor(acc.grossPayMinor),
        totalDeductions: money.toMajor(acc.totalDeductionsMinor),
        netPay: money.toMajor(acc.netPayMinor),
        payslipCount: acc.payslipCount,
        runIds: [...acc.runIds].sort((a, b) => a - b),
    },
});

/**
 * Compute the structured statutory year-end forms for a tax year.
 *
 * @param {number|string} taxYear
 * @param {object} args
 * @param {string|null} args.tenantId  VERIFIED RBAC Company.uuid (req.user.tenantId)
 * @param {object} [args.payer]        optional employer/payer header (name/ein/address)
 * @param {number|null} [args.actorId] audit actor (employee id)
 * @returns {Promise<{taxYear, currency, w2: object[], form1099: object[], summary: object}>}
 */
export const generateYearEndTaxForms = async (
    taxYear,
    { tenantId, payer = {}, actorId = null } = {},
) => {
    const year = validateTaxYear(taxYear);
    const { start, end } = yearWindow(year);

    // FINALIZED runs whose pay date (periodEnd) falls in the tax year, tenant
    // scoped. NON-FINALIZED runs are excluded here, so their payslips never feed
    // the totals.
    const runs = await prisma.payrollRun.findMany({
        where: withTenant(tenantId, {
            status: 'FINALIZED',
            periodEnd: { gte: start, lte: end },
        }),
        select: { id: true, currencyCode: true },
    });

    const currency = runs[0]?.currencyCode ?? 'USD';
    const payerHeader = payerOf(tenantId, payer);

    if (runs.length === 0) {
        return { taxYear: year, currency, w2: [], form1099: [], summary: emptySummary(year) };
    }

    const runIds = runs.map((r) => r.id);

    // Payslips for those runs, tenant-scoped. The employee's national id
    // (SSN/EIN) is c4-encrypted at rest and decrypted to plaintext IN-MEMORY by
    // the prisma extension on this read.
    const payslips = await prisma.payrollPayslip.findMany({
        where: withTenant(tenantId, { payrollRunId: { in: runIds } }),
        include: {
            employee: {
                select: {
                    id: true,
                    employee_code: true,
                    first_name: true,
                    last_name: true,
                    employee_name: true,
                    employee_type: true,
                    nationality_id_no: true,
                    nationality_id_type: true,
                    current_address: true,
                    city: true,
                    state: true,
                    province: true,
                    postal_code: true,
                    country: true,
                },
            },
            earnings: { include: { earningType: true } },
            deductions: { include: { deductionType: true } },
        },
        orderBy: [{ employeeId: 'asc' }, { id: 'asc' }],
    });

    // Aggregate per employee.
    const byEmployee = new Map();
    for (const slip of payslips) {
        const emp = slip.employee;
        if (!emp) continue;
        let entry = byEmployee.get(emp.id);
        if (!entry) {
            entry = { employee: emp, acc: newAccumulator() };
            byEmployee.set(emp.id, entry);
        }
        accumulatePayslip(entry.acc, slip);
    }

    const w2 = [];
    const form1099 = [];
    for (const { employee, acc } of byEmployee.values()) {
        if (isContractor(employee)) {
            form1099.push(build1099(year, currency, employee, acc, payerHeader));
        } else {
            w2.push(buildW2(year, currency, employee, acc, payerHeader));
        }
    }

    const summary = {
        taxYear: year,
        finalizedRunCount: runs.length,
        runIds: runIds.slice().sort((a, b) => a - b),
        payslipCount: payslips.length,
        w2Count: w2.length,
        form1099Count: form1099.length,
        totalW2WagesMinor: w2.reduce((s, r) => s + money.fromMajor(r.boxes.box1_wagesTipsOtherComp), 0),
        totalW2FederalWithheldMinor: w2.reduce((s, r) => s + money.fromMajor(r.boxes.box2_federalIncomeTaxWithheld), 0),
        total1099CompMinor: form1099.reduce((s, r) => s + money.fromMajor(r.boxes.box1_nonemployeeCompensation), 0),
    };

    // STRUCTURED LOG — counts + totals + MASKED tins only. The plaintext SSN/EIN
    // lives exclusively in the returned records; it never reaches a log sink.
    logger.info(
        {
            event: 'tax_forms_generated',
            taxYear: year,
            tenantId,
            finalizedRunCount: runs.length,
            w2Count: w2.length,
            form1099Count: form1099.length,
            tinsMasked: [...w2, ...form1099].map((r) => maskTin(r.recipient.tin)),
        },
        'year-end tax forms generated',
    );

    // AUDIT — describes WHAT was generated, never the decrypted identifiers.
    await logAction({
        employeeId: actorId != null ? Number(actorId) : null,
        actionById: actorId != null ? Number(actorId) : null,
        type: 'TaxFormGeneration',
        actionType: 'TAX_FORMS_GENERATED',
        module: 'Payroll Tax Forms',
        result: 'SUCCESS',
        notes: `Year-end tax forms for ${year}: ${w2.length} W-2(s), ${form1099.length} 1099-NEC(s) from ${runs.length} finalized run(s)`,
    }).catch((e) => logger.warn({ err: e?.message, taxYear: year }, 'tax form audit log failed'));

    return { taxYear: year, currency, w2, form1099, summary };
};

const emptySummary = (year) => ({
    taxYear: year,
    finalizedRunCount: 0,
    runIds: [],
    payslipCount: 0,
    w2Count: 0,
    form1099Count: 0,
    totalW2WagesMinor: 0,
    totalW2FederalWithheldMinor: 0,
    total1099CompMinor: 0,
});

/**
 * Render a statutory export artifact (a downloadable file) for one form type.
 *
 * @param {number|string} taxYear
 * @param {object} args
 * @param {string|null} args.tenantId
 * @param {'W-2'|'1099-NEC'|'w2'|'1099'} args.formType
 * @param {string} [args.format='csv']
 * @param {object} [args.payer]
 * @param {number|null} [args.actorId]
 * @returns {Promise<{formType, format, filename, contentType, content, summary}>}
 */
export const exportYearEndTaxForms = async (
    taxYear,
    { tenantId, formType, format = 'csv', payer = {}, actorId = null } = {},
) => {
    const canonicalForm = canonicalFormType(formType);
    const fmt = String(format).toLowerCase();
    if (!isSupportedExport(canonicalForm, fmt)) {
        const supported = Object.keys(TAX_FORM_FORMATTERS[canonicalForm] ?? {}).join(', ') || 'none';
        throw fail(400, 'HR-1401', `Unsupported export format '${format}' for ${canonicalForm} (supported: ${supported})`);
    }

    const { w2, form1099, summary } = await generateYearEndTaxForms(taxYear, { tenantId, payer, actorId });
    const records = canonicalForm === 'W-2' ? w2 : form1099;

    const descriptor = TAX_FORM_FORMATTERS[canonicalForm][fmt];
    const content = descriptor.build(records);
    const slug = canonicalForm === 'W-2' ? 'w2' : '1099nec';
    const filename = `${slug}-${summary.taxYear}.${descriptor.ext}`;

    return {
        formType: canonicalForm,
        format: fmt,
        filename,
        contentType: descriptor.contentType,
        content,
        summary: { ...summary, exportedFormType: canonicalForm, exportedCount: records.length },
    };
};

// Map a caller form selector to the canonical statutory form type.
export const canonicalFormType = (formType) => {
    const f = norm(formType).replace(/[\s_-]/g, '');
    if (f === 'W2' || f === '') return 'W-2';
    if (f === '1099' || f === '1099NEC' || f === 'NEC') return '1099-NEC';
    throw fail(400, 'HR-1403', `Unknown tax form type '${formType}' (expected 'w2' or '1099')`);
};

export default {
    generateYearEndTaxForms,
    exportYearEndTaxForms,
    canonicalFormType,
    classifyWithholding,
    isContractor,
    maskTin,
};
