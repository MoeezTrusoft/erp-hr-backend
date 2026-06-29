// HR-BANKFILE-03 / HR-PAY-04 — bank/ACH disbursement export from a FINALIZED run.
//
// TDD for bankFileService.generateBankDisbursementFile:
//   (a) a FINALIZED run with payslips → a valid file with ONE disbursement row
//       per employee, the correct NET amount, in both NACHA and CSV formats.
//   (b) a non-FINALIZED run is rejected (status gate).
//   (c) cross-tenant / unknown run id → not-found (service throws 404; the
//       route test asserts the 404 mapping + the 403 permission gate).
//   (d) bank account numbers NEVER appear in logs (pino logger) or the audit
//       row (logAction) — only counts/totals/masked last-4.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mk = () => ({
    findFirst: jest.fn(),
    findMany: jest.fn(),
});

const prismaMock = {
    payrollRun: mk(),
    payrollPayslip: mk(),
};

const loggerMock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};
const logActionMock = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: logActionMock }));

const bankFile = await import('../../src/services/bankFileService.js');

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

// Two employees with DISTINCT, recognisable account numbers so a log-leak is
// detectable. Decryption is transparent at the prisma boundary, so the mock
// returns plaintext (exactly what the real extension yields on read).
const ACCT_1 = '123456789012';
const ACCT_2 = '987654321098';
const ROUTING = '021000021'; // valid 9-digit routing (Chase)

const finalizedRun = {
    id: 10,
    tenantId: TENANT_A,
    status: 'FINALIZED',
    currencyCode: 'USD',
    periodEnd: new Date('2026-01-31T00:00:00Z'),
};

const payslips = [
    {
        id: 1,
        employeeId: 100,
        netAmount: 2500.5, // → 250050 cents
        employee: {
            id: 100,
            first_name: 'Ada',
            last_name: 'Lovelace',
            employee_name: 'Ada Lovelace',
            bankDetails: [
                { accountNumber: ACCT_1, routingNumber: ROUTING, accountType: 'CHECKING', isPrimary: true, bankName: 'Chase' },
            ],
        },
    },
    {
        id: 2,
        employeeId: 200,
        netAmount: 1999.99, // → 199999 cents
        employee: {
            id: 200,
            first_name: 'Alan',
            last_name: 'Turing',
            employee_name: 'Alan Turing',
            bankDetails: [
                { accountNumber: ACCT_2, routingNumber: ROUTING, accountType: 'SAVINGS', isPrimary: true, bankName: 'Chase' },
            ],
        },
    },
];

// Wire the tenant-scoped reads the service performs.
const wireFinalized = () => {
    prismaMock.payrollRun.findFirst.mockImplementation(async ({ where }) =>
        where.id === 10 && where.tenantId === TENANT_A ? { ...finalizedRun } : null,
    );
    prismaMock.payrollPayslip.findMany.mockImplementation(async ({ where }) =>
        where.tenantId === TENANT_A ? payslips : [],
    );
};

beforeEach(() => {
    for (const model of Object.values(prismaMock)) for (const fn of Object.values(model)) fn.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
});

describe('(a) FINALIZED run → valid file, one disbursement row per employee', () => {
    it('NACHA: one type-6 Entry Detail per employee with the correct NET in cents', async () => {
        wireFinalized();

        const out = await bankFile.generateBankDisbursementFile(10, { tenantId: TENANT_A, format: 'nacha' });

        const lines = out.content.split('\n');
        const entries = lines.filter((l) => l.startsWith('6'));
        expect(entries).toHaveLength(2); // one row per employee

        // amount field is the 10-char zero-filled cents block; assert both nets.
        expect(out.content).toContain('0000250050'); // 2500.50
        expect(out.content).toContain('0000199999'); // 1999.99

        // every record is the fixed 94-char NACHA width and the file is block-aligned.
        expect(lines.every((l) => l.length === 94)).toBe(true);
        expect(lines.length % 10).toBe(0);

        expect(out.format).toBe('nacha');
        expect(out.filename).toBe('disbursement-run-10.ach');
        expect(out.summary.rowCount).toBe(2);
        expect(out.summary.totalMinor).toBe(250050 + 199999);
    });

    it('CSV: one data row per employee with major-unit amount + the real account', async () => {
        wireFinalized();

        const out = await bankFile.generateBankDisbursementFile(10, { tenantId: TENANT_A, format: 'csv' });

        const lines = out.content.trim().split('\n');
        expect(lines).toHaveLength(3); // header + 2 employees
        expect(lines[0]).toContain('account_number');
        expect(out.content).toContain(ACCT_1);
        expect(out.content).toContain(ACCT_2);
        expect(out.content).toContain('2500.50');
        expect(out.content).toContain('1999.99');
        expect(out.contentType).toBe('text/csv');
        expect(out.filename).toBe('disbursement-run-10.csv');
    });
});

describe('(b) non-FINALIZED run is rejected', () => {
    it.each(['DRAFT', 'PENDING', 'PROCESSING', 'APPROVED', 'COMPLETED'])('rejects status %s with 409', async (status) => {
        prismaMock.payrollRun.findFirst.mockResolvedValue({ ...finalizedRun, status });

        await expect(
            bankFile.generateBankDisbursementFile(10, { tenantId: TENANT_A, format: 'nacha' }),
        ).rejects.toMatchObject({ statusCode: 409, code: 'HR-1211' });

        expect(prismaMock.payrollPayslip.findMany).not.toHaveBeenCalled(); // no payslip read
    });
});

describe('(c) tenant scope — cross-tenant / unknown run id → 404', () => {
    it('scopes the run read by tenantId and 404s a cross-tenant id', async () => {
        wireFinalized();

        await expect(
            bankFile.generateBankDisbursementFile(10, { tenantId: TENANT_B, format: 'nacha' }),
        ).rejects.toMatchObject({ statusCode: 404, code: 'HR-1210' });

        // proves the run read carried the tenant predicate verbatim.
        expect(prismaMock.payrollRun.findFirst.mock.calls[0][0].where.tenantId).toBe(TENANT_B);
    });

    it('payslip read is also tenant-scoped', async () => {
        wireFinalized();
        await bankFile.generateBankDisbursementFile(10, { tenantId: TENANT_A, format: 'nacha' });
        expect(prismaMock.payrollPayslip.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_A);
    });
});

describe('(d) bank account numbers NEVER appear in logs or the audit row', () => {
    it('no plaintext account in logger or logAction; only masked last-4 + counts', async () => {
        wireFinalized();

        await bankFile.generateBankDisbursementFile(10, { tenantId: TENANT_A, format: 'nacha', actorId: 7 });

        const loggerBlob = JSON.stringify(loggerMock.info.mock.calls)
            + JSON.stringify(loggerMock.warn.mock.calls)
            + JSON.stringify(loggerMock.error.mock.calls);
        const auditBlob = JSON.stringify(logActionMock.mock.calls);

        for (const acct of [ACCT_1, ACCT_2]) {
            expect(loggerBlob).not.toContain(acct);
            expect(auditBlob).not.toContain(acct);
        }
        // masked form IS present in the structured log (correlatable, not sensitive).
        expect(loggerBlob).toContain('****9012');
        expect(loggerBlob).toContain('****1098');
        // an audit row was written.
        expect(logActionMock).toHaveBeenCalledTimes(1);
    });

    it('maskAccount only ever exposes the last 4 digits', () => {
        expect(bankFile.maskAccount(ACCT_1)).toBe('****9012');
        expect(bankFile.maskAccount('12')).toBe('****');
    });
});

describe('missing bank details / unsupported format are hard errors (no leak)', () => {
    it('422 listing employee IDS (never account data) when bank details are missing', async () => {
        prismaMock.payrollRun.findFirst.mockResolvedValue({ ...finalizedRun });
        prismaMock.payrollPayslip.findMany.mockResolvedValue([
            { id: 9, employeeId: 300, netAmount: 1000, employee: { id: 300, employee_name: 'No Bank', bankDetails: [] } },
        ]);

        await expect(
            bankFile.generateBankDisbursementFile(10, { tenantId: TENANT_A, format: 'nacha' }),
        ).rejects.toMatchObject({ statusCode: 422, code: 'HR-1212' });
    });

    it('400 for an unsupported format', async () => {
        await expect(
            bankFile.generateBankDisbursementFile(10, { tenantId: TENANT_A, format: 'xml' }),
        ).rejects.toMatchObject({ statusCode: 400, code: 'HR-1213' });
    });
});
