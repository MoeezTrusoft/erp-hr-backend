// HR-PAYROLL-DEDUCTION-TYPE-01 — every bridge deduction was stored as INCOME TAX.
//
// The payslip TEXT was always right ("Loan Repayment (ID:12)"), so nothing a
// human reads was wrong. The ROW was wrong: `processPayrollRun` persisted
//
//     deductionTypeId: d.deductionTypeId ?? (attendance) ?? incomeTaxDeductionTypeId
//
// and every bridge in buildPayslipFromInputs emitted `deductionTypeId: null`.
// Benefits, loans, LWP recovery and the statutory lines (EOBI, FICA Social
// Security, FICA Medicare, NI, EPF, ESI) therefore all collapsed into the
// INCOME_TAX type. Any aggregate by deduction type — and every year-end tax
// form in taxFormService.js, which buckets withholding by deduction TYPE — was
// inflated by every non-tax deduction on the payslip.
//
// The golden-file test cannot catch this: it asserts on the payslip OBJECT
// returned by buildPayslipFromInputs, where deductionTypeId is still null. The
// corruption happens in the persistence step AFTER it. So these specs drive the
// real processPayrollRun over a mocked Prisma singleton and assert on the rows
// handed to `payrollPayslip.create({ data: { deductions: { create: [...] } } })`
// — the actual PayrollDeduction rows.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mk = () => ({
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
});

const prismaMock = {
    payrollRun: mk(),
    payrollPayslip: mk(),
    payrollEarning: mk(),
    payrollDeduction: mk(),
    payrollEarningType: mk(),
    payrollDeductionType: mk(),
    payrollAssignment: mk(),
    payrollAuditLog: mk(),
    payrollRuleConfig: mk(),
    attendanceDeductionRule: mk(),
    overtimeRequest: mk(),
    leaveRequest: mk(),
    employeeBenefit: mk(),
    loan: mk(),
    loanRepayment: mk(),
    taxRate: mk(),
    employee: mk(),
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));

const payroll = await import('../../src/services/payrollService.js');

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const RUN_ID = 77;
const PROCESSOR = 99;

const US_RATES = [
    { id: 1, countryCode: 'US', bracketMin: 0, bracketMax: 5000, rate: 0.1, effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
    { id: 2, countryCode: 'US', bracketMin: 5000, bracketMax: null, rate: 0.2, effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
];

const ATT_RULE = {
    ruleKey: 'LATE',
    enabled: true,
    triggerCount: 1,
    deductionDays: 1,
    periodScope: 'PAY_PERIOD',
    maxDeductionDaysPerPeriod: null,
    counterGroup: null,
};

// Every deduction TYPE row the run created, keyed by code, so a persisted
// deductionTypeId can be resolved back to the code it was filed under.
let typeStore;

const setup = ({
    countryCode = 'US',
    currencyCode = 'USD',
    ruleConfig = null,
    taxRateRows = US_RATES,
    benefits = [],
    loans = [],
    unpaidLeaves = [],
    attendanceRules = [],
    attendance = [],
} = {}) => {
    typeStore = new Map();
    for (const model of Object.values(prismaMock)) {
        for (const fn of Object.values(model)) fn.mockReset();
    }

    const payrollRun = {
        id: RUN_ID,
        tenantId: TENANT,
        status: 'PENDING',
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        periodEnd: new Date('2026-06-30T00:00:00.000Z'),
        countryCode,
        currencyCode,
    };

    prismaMock.payrollRun.findFirst.mockResolvedValue(payrollRun);
    prismaMock.payrollRun.updateMany.mockResolvedValue({ count: 1 });

    prismaMock.employee.findMany.mockResolvedValue([
        {
            id: 4242,
            hire_date: null,
            term_date: null,
            employmentTerms: [{ id: 1, baseSalary: 6543.21, payFrequency: 'MONTHLY', currency: currencyCode }],
            payrollAssignments: [],
            attendance,
            attendanceAnomalies: [],
        },
    ]);

    prismaMock.attendanceDeductionRule.findMany.mockResolvedValue(attendanceRules);
    prismaMock.payrollRuleConfig.findUnique.mockResolvedValue(ruleConfig);
    prismaMock.taxRate.findMany.mockResolvedValue(taxRateRows);

    prismaMock.payrollEarningType.findFirst.mockResolvedValue({ id: 900, code: 'BASE_SALARY' });

    // Lazy get-or-create, backed by a store so a second lookup of the same code
    // finds the row the first one created (and never creates it twice).
    prismaMock.payrollDeductionType.findFirst.mockImplementation(
        async ({ where }) => typeStore.get(where.code) ?? null,
    );
    prismaMock.payrollDeductionType.create.mockImplementation(async ({ data }) => {
        const row = { id: 1000 + typeStore.size, ...data };
        typeStore.set(data.code, row);
        return row;
    });

    prismaMock.overtimeRequest.findMany.mockResolvedValue([]);
    prismaMock.leaveRequest.findMany.mockResolvedValue(unpaidLeaves);
    prismaMock.employeeBenefit.findMany.mockResolvedValue(benefits);
    prismaMock.loan.findMany.mockResolvedValue(loans);
    prismaMock.loan.update.mockResolvedValue({});
    prismaMock.loanRepayment.create.mockResolvedValue({ id: 1 });

    prismaMock.payrollPayslip.findFirst.mockResolvedValue(null);
    prismaMock.payrollPayslip.create.mockImplementation(async ({ data }) => ({ id: 7001, ...data }));

    prismaMock.payrollAuditLog.create.mockResolvedValue({ id: 1 });
};

// The persisted PayrollDeduction rows, in persistence order.
const persistedDeductions = () =>
    prismaMock.payrollPayslip.create.mock.calls[0][0].data.deductions.create;

// code a persisted row was filed under
const codeOf = (row) => {
    for (const t of typeStore.values()) if (t.id === row.deductionTypeId) return t.code;
    return null;
};

const codesByDescription = () =>
    Object.fromEntries(persistedDeductions().map((d) => [d.description, codeOf(d)]));

beforeEach(() => {
    for (const model of Object.values(prismaMock)) {
        for (const fn of Object.values(model)) fn.mockReset();
    }
});

describe('HR-PAYROLL-DEDUCTION-TYPE-01 — persisted rows carry their OWN deduction type', () => {
    it('files benefits, loans, LWP, attendance and FICA under distinct types — none as INCOME_TAX', async () => {
        setup({
            benefits: [{
                electedAmountMinor: 5000,
                benefitPlan: { name: 'Health', employerContributionMinor: 0, employeeContributionMinor: 5000 },
            }],
            loans: [{ id: 12, monthlyInstallmentMinor: 25000, outstandingMinor: 500000 }],
            unpaidLeaves: [{ totalDays: 2, leavePolicy: { leaveTypeCode: 'UNPAID' } }],
            attendanceRules: [ATT_RULE],
            attendance: [{ date: new Date('2026-06-10T00:00:00.000Z'), status: 'LATE', manually_corrected: false }],
        });

        await payroll.processPayrollRun(RUN_ID, PROCESSOR, TENANT);

        expect(codesByDescription()).toEqual({
            'Benefit: Health': 'BENEFIT_CONTRIBUTION',
            'Loan Repayment (ID:12)': 'LOAN_REPAYMENT',
            'LWP Recovery (2 days)': 'LWP_RECOVERY',
            'Attendance: LATE (1 occurrence = 1 day)': 'ATTENDANCE_DEDUCTION',
            'Social Security (FICA)': 'FICA_SOCIAL_SECURITY',
            'Medicare (FICA)': 'FICA_MEDICARE',
            'Income Tax': 'INCOME_TAX',
        });

        // No row may be typeless, and only the tax line may be INCOME_TAX.
        const rows = persistedDeductions();
        expect(rows.every((d) => Number.isInteger(d.deductionTypeId))).toBe(true);
        expect(rows.filter((d) => codeOf(d) === 'INCOME_TAX')).toHaveLength(1);
    });

    it('keeps EOBI and FICA as SEPARATE statutory types (different obligations)', async () => {
        setup({ countryCode: 'PK', currencyCode: 'PKR', ruleConfig: { eobiEnabled: true }, taxRateRows: [] });
        await payroll.processPayrollRun(RUN_ID, PROCESSOR, TENANT);
        expect(codesByDescription()).toEqual({ 'EOBI (Employee)': 'EOBI_EMPLOYEE' });

        setup();
        await payroll.processPayrollRun(RUN_ID, PROCESSOR, TENANT);
        const us = codesByDescription();
        expect(us['Social Security (FICA)']).toBe('FICA_SOCIAL_SECURITY');
        expect(us['Medicare (FICA)']).toBe('FICA_MEDICARE');
        // and the two FICA halves are not one shared type either
        expect(us['Social Security (FICA)']).not.toBe(us['Medicare (FICA)']);
    });

    // The IN statutory branch (EPF/ESI) is NOT covered here: src/lib/money.js
    // has no INR exponent and the ESI cap hardcodes decimalToMinor(_, 'INR'),
    // so an Indian run throws HR-2008 before it ever reaches persistence. That
    // is a pre-existing defect of its own, not this finding's.
    it('gives NI its own type too', async () => {
        setup({ countryCode: 'GB', currencyCode: 'GBP', taxRateRows: [] });
        await payroll.processPayrollRun(RUN_ID, PROCESSOR, TENANT);
        expect(codesByDescription()).toEqual({ 'National Insurance (NI)': 'NATIONAL_INSURANCE' });
    });

    it('creates deduction types LAZILY — none for a line the tenant never emits', async () => {
        setup({ taxRateRows: [] }); // no tax table ⇒ no income-tax line at all
        await payroll.processPayrollRun(RUN_ID, PROCESSOR, TENANT);

        const created = [...typeStore.keys()].sort();
        expect(created).toEqual(['FICA_MEDICARE', 'FICA_SOCIAL_SECURITY']);
        // the catch-all is gone: no INCOME_TAX row is minted for a run with no tax
        expect(created).not.toContain('INCOME_TAX');
        expect(created).not.toContain('LOAN_REPAYMENT');
        expect(created).not.toContain('EOBI_EMPLOYEE');
    });

    it('resolves each type ONCE per run, not once per line', async () => {
        setup({
            loans: [{ id: 12, monthlyInstallmentMinor: 25000, outstandingMinor: 500000 }],
        });
        await payroll.processPayrollRun(RUN_ID, PROCESSOR, TENANT);

        const created = prismaMock.payrollDeductionType.create.mock.calls.map((c) => c[0].data.code);
        expect(new Set(created).size).toBe(created.length); // no duplicate creates
    });

    it('does not reorder or re-price the deduction lines (determinism contract)', async () => {
        setup({
            benefits: [{
                electedAmountMinor: 5000,
                benefitPlan: { name: 'Health', employerContributionMinor: 0, employeeContributionMinor: 5000 },
            }],
            loans: [{ id: 12, monthlyInstallmentMinor: 25000, outstandingMinor: 500000 }],
        });
        await payroll.processPayrollRun(RUN_ID, PROCESSOR, TENANT);

        const rows = persistedDeductions();
        expect(rows.map((d) => d.description)).toEqual([
            'Benefit: Health',
            'Loan Repayment (ID:12)',
            'Social Security (FICA)',
            'Medicare (FICA)',
            'Income Tax',
        ]);
        // amounts are fixed-precision STRINGS; compare numerically, never as floats
        expect(rows.map((d) => d.amount)).toEqual(rows.map((d) => String(d.amount)));
        expect(Number(rows[0].amount)).toBe(50);
        expect(Number(rows[1].amount)).toBe(250);
    });

    it('files the same rows on a RE-PROCESS (idempotent path) as on first write', async () => {
        setup({
            loans: [{ id: 12, monthlyInstallmentMinor: 25000, outstandingMinor: 500000 }],
        });
        await payroll.processPayrollRun(RUN_ID, PROCESSOR, TENANT);
        const first = codesByDescription();

        setup({
            loans: [{ id: 12, monthlyInstallmentMinor: 25000, outstandingMinor: 500000 }],
        });
        prismaMock.payrollPayslip.findFirst.mockResolvedValue({ id: 7001, grossAmount: '0', totalDeductions: '0', netAmount: '0' });
        prismaMock.payrollPayslip.update.mockImplementation(async ({ data }) => ({ id: 7001, ...data }));
        prismaMock.payrollEarning.deleteMany.mockResolvedValue({ count: 0 });
        prismaMock.payrollDeduction.deleteMany.mockResolvedValue({ count: 0 });

        await payroll.processPayrollRun(RUN_ID, PROCESSOR, TENANT);

        const rows = prismaMock.payrollPayslip.update.mock.calls[0][0].data.deductions.create;
        const again = Object.fromEntries(rows.map((d) => [d.description, codeOf(d)]));
        expect(again).toEqual(first);
        expect(rows.every((d) => Number.isInteger(d.deductionTypeId))).toBe(true);
    });
});
