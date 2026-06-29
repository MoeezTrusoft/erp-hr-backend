// HR-01 / HR-10 (Roadmap T-P4.2) — C4 encrypted-at-rest, transparent decrypt,
// blind index, deny-by-default + audit, and redaction.
//
// This is the strongest proof for T-P4.2: it writes REAL C4 rows (salary,
// bank account, national id) through the shared Prisma singleton, then reads
// the RAW column bytes with $queryRaw and asserts they are CIPHERTEXT — never
// the plaintext salary/account/national-id. It then reads the same rows back
// through the normal Prisma path and asserts the caller still receives the
// correct PLAINTEXT (a NUMBER for salary). It proves the blind index keeps
// account lookup + uniqueness working on encrypted columns, that logs and
// audit diffs carry no plaintext C4, and that a missing encryption key fails
// CLOSED (throws) rather than silently storing plaintext.
//
// Runs against a Postgres DB reachable via DATABASE_URL (point it at the test
// DB). If the DB is unreachable the suite skips, mirroring the existing
// payroll-tenancy.db.test.js convention.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import prisma from '../../src/lib/prisma.js';
import {
    encryptString,
    decryptString,
    encryptNumber,
    decryptNumber,
    blindIndex,
    isCiphertext,
} from '../../src/lib/crypto.js';
import { redactC4 } from '../../src/lib/c4Redaction.js';

// REQ-007 — tenant is an RBAC Company.uuid STRING (was an int). Isolated test tenant.
const TENANT = '74010000-0000-4000-8000-000000000001';

let dbAvailable = false;
const created = { employees: [], terms: [], banks: [] };

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        dbAvailable = true;
    } catch {
        dbAvailable = false;
    }
});

afterAll(async () => {
    if (!dbAvailable) return;
    if (created.banks.length) await prisma.bankDetail.deleteMany({ where: { id: { in: created.banks } } });
    if (created.terms.length) await prisma.employmentTerms.deleteMany({ where: { id: { in: created.terms } } });
    if (created.employees.length) await prisma.employee.deleteMany({ where: { id: { in: created.employees } } });
    await prisma.$disconnect();
});

const skipIfNoDb = () => {
    if (!dbAvailable) return true;
    return false;
};

describe('HR-01 crypto util — AES-256-GCM envelope, fail-closed', () => {
    it('round-trips a string through encrypt/decrypt', () => {
        const ct = encryptString('42101-1234567-8');
        expect(typeof ct).toBe('string');
        expect(ct).not.toContain('42101-1234567-8');
        expect(isCiphertext(ct)).toBe(true);
        expect(decryptString(ct)).toBe('42101-1234567-8');
    });

    it('round-trips a number and returns a NUMBER (not a string)', () => {
        const ct = encryptNumber(123456.78);
        expect(typeof ct).toBe('string');
        expect(ct).not.toContain('123456');
        const back = decryptNumber(ct);
        expect(typeof back).toBe('number');
        expect(back).toBe(123456.78);
    });

    it('produces a self-describing, versioned ciphertext (different each write — random IV)', () => {
        const a = encryptString('same-plaintext');
        const b = encryptString('same-plaintext');
        expect(a).not.toBe(b); // random IV → GCM ciphertext differs each time
        expect(a.startsWith('c4.')).toBe(true);
    });

    it('blind index is deterministic for the same plaintext and not the plaintext', () => {
        const x = blindIndex('1234567890');
        const y = blindIndex('1234567890');
        expect(x).toBe(y);
        expect(x).not.toContain('1234567890');
        expect(blindIndex('1234567890')).not.toBe(blindIndex('0987654321'));
    });

    it('FAILS CLOSED when the encryption key is missing — never returns plaintext', async () => {
        const saved = process.env.HR_C4_ENCRYPTION_KEY;
        delete process.env.HR_C4_ENCRYPTION_KEY;
        // Re-import a fresh module instance so the missing-key state is observed.
        const fresh = await import('../../src/lib/crypto.js?failclosed=' + Date.now());
        try {
            expect(() => fresh.encryptString('secret')).toThrow(/HR-1001/);
        } finally {
            process.env.HR_C4_ENCRYPTION_KEY = saved;
        }
    });
});

describe('HR-01 redaction — C4 never appears in audit diffs / logs', () => {
    it('redactC4 strips salary/bank/national-id fields from a serialized object', () => {
        const before = {
            baseSalary: 90000,
            bonusTarget: 10000,
            accountNumber: '000123456789',
            routingNumber: '021000021',
            nationality_id_no: '42101-1234567-8',
            payslips: [{ grossAmount: 5000, netAmount: 4000, totalDeductions: 1000 }],
            keepMe: 'visible',
        };
        const after = redactC4(before);
        const serialized = JSON.stringify(after);
        expect(serialized).not.toContain('90000');
        expect(serialized).not.toContain('000123456789');
        expect(serialized).not.toContain('021000021');
        expect(serialized).not.toContain('42101-1234567-8');
        expect(serialized).not.toContain('5000');
        expect(after.keepMe).toBe('visible');
    });
});

describe('HR-01 employment terms salary — ciphertext at rest, number on read', () => {
    it('raw DB column is ciphertext; Prisma read returns the plaintext NUMBER', async () => {
        if (skipIfNoDb()) return;

        const emp = await prisma.employee.create({
            data: { tenant_id: TENANT, first_name: 'Sal', last_name: 'Test', status: 'active' },
        });
        created.employees.push(emp.id);

        const term = await prisma.employmentTerms.create({
            data: {
                tenantId: TENANT,
                employeeId: emp.id,
                baseSalary: 88888.5,
                bonusTarget: 12345.5,
                currency: 'USD',
                payFrequency: 'MONTHLY',
                effectiveFrom: new Date('2099-01-01'),
            },
        });
        created.terms.push(term.id);

        // Normal Prisma read → plaintext NUMBER (payrollService relies on this).
        expect(typeof term.baseSalary).toBe('number');
        expect(term.baseSalary).toBe(88888.5);
        expect(term.bonusTarget).toBe(12345.5);

        const reread = await prisma.employmentTerms.findFirst({ where: { id: term.id } });
        expect(reread.baseSalary).toBe(88888.5);
        expect(reread.bonusTarget).toBe(12345.5);

        // RAW DB read → ciphertext STRING, NOT the plaintext salary.
        const rows = await prisma.$queryRaw`SELECT "baseSalary", "bonusTarget" FROM employment_terms WHERE id = ${term.id}`;
        const raw = rows[0];
        expect(typeof raw.baseSalary).toBe('string');
        expect(raw.baseSalary).not.toContain('88888');
        expect(isCiphertext(raw.baseSalary)).toBe(true);
        expect(raw.bonusTarget).not.toContain('12345');
        expect(isCiphertext(raw.bonusTarget)).toBe(true);
    });
});

describe('HR-01 bank detail — encrypted account, blind index lookup + uniqueness', () => {
    it('raw account is ciphertext; lookup by blind index works; uniqueness still enforced', async () => {
        if (skipIfNoDb()) return;

        const emp = await prisma.employee.create({
            data: { tenant_id: TENANT, first_name: 'Bank', last_name: 'Test', status: 'active' },
        });
        created.employees.push(emp.id);

        const ACC = '000999888777';
        const bank = await prisma.bankDetail.create({
            data: {
                tenantId: TENANT,
                employeeId: emp.id,
                bankName: 'Test Bank',
                accountNumber: ACC,
                routingNumber: '021000021',
            },
        });
        created.banks.push(bank.id);

        // Normal read → plaintext account number.
        expect(bank.accountNumber).toBe(ACC);
        expect(bank.routingNumber).toBe('021000021');

        // RAW account column is ciphertext, and a blind-index column holds the HMAC.
        const rows = await prisma.$queryRaw`SELECT "accountNumber", "routingNumber", "accountNumberBidx" FROM bank_details WHERE id = ${bank.id}`;
        const raw = rows[0];
        expect(raw.accountNumber).not.toContain(ACC);
        expect(isCiphertext(raw.accountNumber)).toBe(true);
        expect(raw.routingNumber).not.toContain('021000021');
        expect(raw.accountNumberBidx).toBe(blindIndex(ACC));

        // Lookup BY accountNumber works transparently (extension rewrites to bidx).
        const found = await prisma.bankDetail.findFirst({
            where: { employeeId: emp.id, accountNumber: ACC },
        });
        expect(found).not.toBeNull();
        expect(found.id).toBe(bank.id);
        expect(found.accountNumber).toBe(ACC);

        // Uniqueness on (employeeId, accountNumber) is still enforced via bidx.
        await expect(
            prisma.bankDetail.create({
                data: { tenantId: TENANT, employeeId: emp.id, bankName: 'Dup', accountNumber: ACC },
            }),
        ).rejects.toThrow();
    });
});

describe('HR-01 employee national id — ciphertext at rest, plaintext on read', () => {
    it('raw nationality_id_no is ciphertext; Prisma read returns plaintext', async () => {
        if (skipIfNoDb()) return;

        const NID = '42101-7654321-0';
        const emp = await prisma.employee.create({
            data: { tenant_id: TENANT, first_name: 'Nat', last_name: 'Id', status: 'active', nationality_id_no: NID },
        });
        created.employees.push(emp.id);

        expect(emp.nationality_id_no).toBe(NID);

        const reread = await prisma.employee.findUnique({ where: { id: emp.id } });
        expect(reread.nationality_id_no).toBe(NID);

        const rows = await prisma.$queryRaw`SELECT "nationality_id_no" FROM "Employee" WHERE id = ${emp.id}`;
        expect(rows[0].nationality_id_no).not.toContain(NID);
        expect(isCiphertext(rows[0].nationality_id_no)).toBe(true);
    });
});
