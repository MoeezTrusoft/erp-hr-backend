// Handoff #10: HR refuses to start when stored C4 values do not decrypt with the configured key.
import { describe, it, expect, jest } from '@jest/globals';
import { verifyC4Decryptable, c4Columns, runC4StartupCheck, C4_TABLES } from '../../../src/lib/c4SelfCheck.js';
import { C4_FIELDS } from '../../../src/lib/c4Encryption.js';

const cols = [{ table: 'employment_terms', column: 'baseSalary' }, { table: 'bank_details', column: 'accountNumber' }, { table: 'offers', column: 'salary' }];

describe('C4 start-up self-check', () => {
    it('covers every C4 column with a table', () => {
        const all = c4Columns();
        expect(all.length).toBe(Object.values(C4_FIELDS).reduce((n, m) => n + Object.keys(m).length, 0));
        expect(Object.keys(C4_TABLES).sort()).toEqual(Object.keys(C4_FIELDS).sort());
        expect(all.every((c) => c.table)).toBe(true);
    });
    it('passes when every sample decrypts, counting empty columns', async () => {
        const sample = async (t) => (t === 'offers' ? null : 'c4.v1:x');
        await expect(verifyC4Decryptable({ sample, decrypt: () => 'ok', columns: cols })).resolves.toEqual({ checked: 2, empty: 1 });
    });
    it('throws HR-1005 naming only the failing columns (never values)', async () => {
        const decrypt = (v) => { if (v === 'bad') throw new Error('Unsupported state or unable to authenticate data'); return 'ok'; };
        const sample = async (t) => (t === 'bank_details' ? 'bad' : 'c4.v1:good');
        const err = await verifyC4Decryptable({ sample, decrypt, columns: cols }).catch((e) => e);
        expect(err.code).toBe('HR-1005');
        expect(err.failed).toEqual(['bank_details.accountNumber']);
        expect(err.message).not.toContain('bad');
    });
    it('is skipped under test and with HR_C4_SELF_CHECK=off', async () => {
        const prisma = { $transaction: jest.fn() };
        await expect(runC4StartupCheck(prisma, { env: { NODE_ENV: 'test' } })).resolves.toBeNull();
        await expect(runC4StartupCheck(prisma, { env: { NODE_ENV: 'production', HR_C4_SELF_CHECK: 'off' } })).resolves.toBeNull();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
    it('samples raw ciphertext under the transaction-local RLS bypass', async () => {
        const tx = { $executeRaw: jest.fn(async () => 1), $queryRawUnsafe: jest.fn(async () => []) };
        const prisma = { $transaction: jest.fn(async (fn) => fn(tx)) };
        await expect(runC4StartupCheck(prisma, { env: { NODE_ENV: 'production' } })).resolves.toMatchObject({ checked: 0 });
        expect(tx.$executeRaw).toHaveBeenCalled();
        expect(tx.$queryRawUnsafe.mock.calls[0][0]).toMatch(/^SELECT "baseSalary"::text AS v FROM "employment_terms" WHERE "baseSalary"::text LIKE 'c4\.v%' LIMIT 1$/);
    });
});
