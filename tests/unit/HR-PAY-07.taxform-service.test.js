// HR-PAY-07 / HR-SEC-05 — statutory year-end tax forms (W-2 / 1099-NEC).
//
// TDD for taxFormService.generateYearEndTaxForms / exportYearEndTaxForms:
//   (a) a tax year with FINALIZED runs produces correct per-EMPLOYEE W-2 totals
//       (wages = taxable earnings; box2 = federal income-tax withholding) AND a
//       1099-NEC for CONTRACTORS (box1 = gross comp). Multi-run totals aggregate.
//   (b) NON-FINALIZED data is excluded — the run query filters status FINALIZED.
//   (c) tenant scope — every read folds the verified tenantId; a cross-tenant
//       request resolves to its own (empty) data, never another tenant's.
//   (d) SSNs/EINs NEVER appear in logs (pino) or the audit row (logAction) —
//       only counts/totals/masked last-4.
//   (e) the CSV export is fully rendered with the box totals.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mk = () => ({ findMany: jest.fn() });
const prismaMock = { payrollRun: mk(), payrollPayslip: mk() };

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const logActionMock = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: logActionMock }));

const svc = await import('../../src/services/taxFormService.js');

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

// Distinct, recognisable identifiers so a log-leak is detectable. Decryption is
// transparent at the prisma boundary, so the mock returns plaintext (exactly
// what the real C4 extension yields on read).
const SSN_ADA = '111-22-3333';
const EIN_BOB = '98-7654321';

const incomeTax = { code: 'INCOME_TAX', name: 'Income Tax' };
const ssTax = { code: 'SS', name: 'Social Security Tax' };
const medicare = { code: 'MED', name: 'Medicare Tax' };
const stateTax = { code: 'SIT', name: 'State Income Tax' };
const healthPremium = { code: 'HEALTH', name: 'Health Premium' }; // non-statutory deduction
const baseEarning = { isTaxable: true };
const reimbursement = { isTaxable: false }; // excluded from taxable wages

// Employee Ada (W-2): two payslips across two runs.
const adaSlip1 = {
    id: 1, payrollRunId: 10, employeeId: 100, grossAmount: 5000, totalDeductions: 1200, netAmount: 3800,
    employee: {
        id: 100, employee_code: 'E100', first_name: 'Ada', last_name: 'Lovelace', employee_name: 'Ada Lovelace',
        employee_type: 'permanent', nationality_id_no: SSN_ADA, nationality_id_type: 'SSN',
        current_address: '1 Analytical Way', city: 'London', state: 'CA', province: null, postal_code: '94000', country: 'US',
    },
    earnings: [{ amount: 5000, earningType: baseEarning }],
    deductions: [
        { amount: 800, deductionType: incomeTax },
        { amount: 310, deductionType: ssTax },
        { amount: 72, deductionType: medicare },
        { amount: 18, deductionType: healthPremium },
    ],
};
const adaSlip2 = {
    id: 2, payrollRunId: 20, employeeId: 100, grossAmount: 5500, totalDeductions: 1300, netAmount: 4200,
    employee: adaSlip1.employee,
    earnings: [{ amount: 5000, earningType: baseEarning }, { amount: 500, earningType: reimbursement }],
    deductions: [
        { amount: 900, deductionType: incomeTax },
        { amount: 341, deductionType: ssTax },
        { amount: 80, deductionType: medicare },
        { amount: 200, deductionType: stateTax },
    ],
};

// Contractor Bob (1099-NEC): one payslip, gross comp, no tax lines.
const bobSlip = {
    id: 3, payrollRunId: 10, employeeId: 200, grossAmount: 9000, totalDeductions: 0, netAmount: 9000,
    employee: {
        id: 200, employee_code: 'C200', first_name: 'Bob', last_name: 'Builder', employee_name: 'Bob Builder',
        employee_type: 'contractor', nationality_id_no: EIN_BOB, nationality_id_type: 'EIN',
        current_address: '5 Site Rd', city: 'Austin', state: 'TX', province: null, postal_code: '73301', country: 'US',
    },
    earnings: [{ amount: 9000, earningType: baseEarning }],
    deductions: [],
};

const wireTenantA = () => {
    prismaMock.payrollRun.findMany.mockImplementation(async ({ where }) =>
        where.tenantId === TENANT_A
            ? [{ id: 10, currencyCode: 'USD' }, { id: 20, currencyCode: 'USD' }]
            : [],
    );
    prismaMock.payrollPayslip.findMany.mockImplementation(async ({ where }) =>
        where.tenantId === TENANT_A ? [adaSlip1, adaSlip2, bobSlip] : [],
    );
};

beforeEach(() => {
    for (const model of Object.values(prismaMock)) for (const fn of Object.values(model)) fn.mockReset();
    loggerMock.info.mockReset(); loggerMock.warn.mockReset(); loggerMock.error.mockReset();
    logActionMock.mockReset(); logActionMock.mockResolvedValue(undefined);
});

describe('(a) per-recipient W-2 + 1099-NEC totals from finalized runs', () => {
    it('W-2: wages = taxable earnings; box2 = federal income tax; FICA buckets; multi-run aggregation', async () => {
        wireTenantA();
        const out = await svc.generateYearEndTaxForms(2025, { tenantId: TENANT_A, actorId: 7 });

        expect(out.w2).toHaveLength(1);
        expect(out.form1099).toHaveLength(1);

        const w2 = out.w2[0];
        expect(w2.recipient.employeeId).toBe(100);
        expect(w2.recipient.tin).toBe(SSN_ADA);
        // taxable wages: 5000 + 5000 (the 500 reimbursement is non-taxable, excluded)
        expect(w2.boxes.box1_wagesTipsOtherComp).toBe(10000);
        // federal income tax withheld: 800 + 900
        expect(w2.boxes.box2_federalIncomeTaxWithheld).toBe(1700);
        // social security tax: 310 + 341
        expect(w2.boxes.box4_socialSecurityTaxWithheld).toBe(651);
        // medicare tax: 72 + 80
        expect(w2.boxes.box6_medicareTaxWithheld).toBe(152);
        // state income tax: 0 + 200
        expect(w2.boxes.box17_stateIncomeTax).toBe(200);
        // reconciliation gross is the full gross (incl. the non-taxable line)
        expect(w2.reconciliation.grossPay).toBe(10500);
        expect(w2.reconciliation.payslipCount).toBe(2);
        expect(w2.reconciliation.runIds).toEqual([10, 20]);
    });

    it('1099-NEC: contractor box1 = total gross comp; no W-2 emitted for them', async () => {
        wireTenantA();
        const out = await svc.generateYearEndTaxForms(2025, { tenantId: TENANT_A });

        const nec = out.form1099[0];
        expect(nec.formType).toBe('1099-NEC');
        expect(nec.recipient.employeeId).toBe(200);
        expect(nec.recipient.tin).toBe(EIN_BOB);
        expect(nec.boxes.box1_nonemployeeCompensation).toBe(9000);
        expect(nec.boxes.box4_federalIncomeTaxWithheld).toBe(0);
        // the contractor is NOT also a W-2 recipient
        expect(out.w2.some((w) => w.recipient.employeeId === 200)).toBe(false);
    });
});

describe('(b) NON-FINALIZED data is excluded', () => {
    it('the run query filters status === FINALIZED', async () => {
        wireTenantA();
        await svc.generateYearEndTaxForms(2025, { tenantId: TENANT_A });
        expect(prismaMock.payrollRun.findMany.mock.calls[0][0].where.status).toBe('FINALIZED');
    });

    it('no finalized runs → empty forms, no payslip read', async () => {
        prismaMock.payrollRun.findMany.mockResolvedValue([]);
        const out = await svc.generateYearEndTaxForms(2025, { tenantId: TENANT_A });
        expect(out.w2).toEqual([]);
        expect(out.form1099).toEqual([]);
        expect(prismaMock.payrollPayslip.findMany).not.toHaveBeenCalled();
    });
});

describe('(c) tenant scope', () => {
    it('folds the verified tenant into BOTH reads; a cross-tenant request gets empty data', async () => {
        wireTenantA();
        const out = await svc.generateYearEndTaxForms(2025, { tenantId: TENANT_B });
        expect(out.w2).toEqual([]);
        expect(out.form1099).toEqual([]);
        expect(prismaMock.payrollRun.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_B);
    });

    it('the payslip read carries the same tenant predicate', async () => {
        wireTenantA();
        await svc.generateYearEndTaxForms(2025, { tenantId: TENANT_A });
        expect(prismaMock.payrollPayslip.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_A);
    });
});

describe('(d) SSNs/EINs NEVER appear in logs or the audit row', () => {
    it('no plaintext identifier in logger or logAction; masked last-4 only', async () => {
        wireTenantA();
        await svc.generateYearEndTaxForms(2025, { tenantId: TENANT_A, actorId: 7 });

        const loggerBlob = JSON.stringify(loggerMock.info.mock.calls)
            + JSON.stringify(loggerMock.warn.mock.calls) + JSON.stringify(loggerMock.error.mock.calls);
        const auditBlob = JSON.stringify(logActionMock.mock.calls);

        for (const id of [SSN_ADA, EIN_BOB, '111223333', '987654321']) {
            expect(loggerBlob).not.toContain(id);
            expect(auditBlob).not.toContain(id);
        }
        expect(loggerBlob).toContain('****3333'); // masked SSN
        expect(loggerBlob).toContain('****4321'); // masked EIN
        expect(logActionMock).toHaveBeenCalledTimes(1);
    });

    it('maskTin only ever exposes the last 4 digits', () => {
        expect(svc.maskTin(SSN_ADA)).toBe('****3333');
        expect(svc.maskTin('12')).toBe('****');
    });
});

describe('(e) CSV export', () => {
    it('W-2 CSV: header + one row per employee with the box totals + decrypted SSN', async () => {
        wireTenantA();
        const out = await svc.exportYearEndTaxForms(2025, { tenantId: TENANT_A, formType: 'w2', format: 'csv' });

        expect(out.formType).toBe('W-2');
        expect(out.filename).toBe('w2-2025.csv');
        expect(out.contentType).toBe('text/csv');
        const lines = out.content.trim().split('\n');
        expect(lines).toHaveLength(2); // header + Ada
        expect(lines[0]).toContain('box1_wages_tips_other_comp');
        expect(out.content).toContain(SSN_ADA);
        expect(out.content).toContain('10000.00'); // box1
        expect(out.content).toContain('1700.00'); // box2
    });

    it('1099-NEC CSV: one row per contractor with box1', async () => {
        wireTenantA();
        const out = await svc.exportYearEndTaxForms(2025, { tenantId: TENANT_A, formType: '1099', format: 'csv' });
        expect(out.formType).toBe('1099-NEC');
        expect(out.filename).toBe('1099nec-2025.csv');
        const lines = out.content.trim().split('\n');
        expect(lines).toHaveLength(2); // header + Bob
        expect(out.content).toContain(EIN_BOB);
        expect(out.content).toContain('9000.00');
    });

    it('rejects an unsupported export format / unknown form type / invalid year', async () => {
        wireTenantA();
        await expect(svc.exportYearEndTaxForms(2025, { tenantId: TENANT_A, formType: 'w2', format: 'pdf' }))
            .rejects.toMatchObject({ statusCode: 400, code: 'HR-1401' });
        await expect(svc.exportYearEndTaxForms(2025, { tenantId: TENANT_A, formType: 'zzz', format: 'csv' }))
            .rejects.toMatchObject({ statusCode: 400, code: 'HR-1403' });
        await expect(svc.generateYearEndTaxForms('not-a-year', { tenantId: TENANT_A }))
            .rejects.toMatchObject({ statusCode: 400, code: 'HR-1400' });
    });
});
