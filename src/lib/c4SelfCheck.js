// src/lib/c4SelfCheck.js — production handoff #10.
//
// The C4 keys were lost once (Nov 2026) and the data had to be re-encrypted
// (erp-trusoft-k8s hr-c4-repair.py). With a wrong or rotated key the app used
// to start normally and fail only when a salary/bank/ID value was read. This
// start-up check decrypts ONE stored ciphertext per C4 column and refuses to
// start if any fails, so a key mismatch is caught at deploy, not by a user.
//
// It reads raw ciphertext (bypassing the C4 decrypt extension) under the system
// context, never logs values, and names only the table/column that failed.
// HR_C4_SELF_CHECK=off skips it (emergency only).
import { C4_FIELDS } from './c4Encryption.js';
import { decryptString } from './crypto.js';

// Prisma model key (as in C4_FIELDS) -> physical table.
export const C4_TABLES = {
    employmentTerms: 'employment_terms',
    bankDetail: 'bank_details',
    employee: 'Employee',
    offer: 'offers',
};

const ident = (s) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`HR-1005 unsafe identifier ${s}`);
    return `"${s}"`;
};

/** Every (table, column) pair the check samples. */
export function c4Columns(fields = C4_FIELDS, tables = C4_TABLES) {
    return Object.entries(fields).flatMap(([model, cols]) =>
        Object.keys(cols).map((column) => ({ table: tables[model], column })));
}

/**
 * @param {{ sample: (table: string, column: string) => Promise<string|null>, decrypt?: Function }} deps
 *   sample returns one stored c4.v* value for that column, or null when none is stored.
 * @returns {Promise<{ checked: number, empty: number }>}
 * @throws HR-1005 naming every column whose sample does not decrypt.
 */
export async function verifyC4Decryptable({ sample, decrypt = decryptString, columns = c4Columns() }) {
    const failed = [];
    let checked = 0;
    let empty = 0;
    for (const { table, column } of columns) {
        if (!table) { failed.push(`${column} (no table mapping)`); continue; }
        const value = await sample(table, column);
        if (value === null || value === undefined) { empty += 1; continue; }
        try {
            decrypt(value);
            checked += 1;
        } catch {
            failed.push(`${table}.${column}`);
        }
    }
    if (failed.length) {
        throw Object.assign(
            new Error(`HR-1005 C4 values do not decrypt with HR_C4_ENCRYPTION_KEY: ${failed.join(', ')}. Refusing to start.`),
            { code: 'HR-1005', failed },
        );
    }
    return { checked, empty };
}

/**
 * Sampler over a Prisma client. Raw SQL so the C4 extension leaves the
 * ciphertext alone; run in a transaction with the transaction-local RLS bypass
 * (FORCE RLS would otherwise hide every row and the check would pass vacuously).
 */
export const prismaSampler = (prisma) => async (table, column) => {
    const sql = `SELECT ${ident(column)}::text AS v FROM ${ident(table)} WHERE ${ident(column)}::text LIKE 'c4.v%' LIMIT 1`;
    const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_bypass', 'on', true)`;
        return tx.$queryRawUnsafe(sql);
    });
    return rows?.[0]?.v ?? null;
};

/** Start-up hook: resolves, or throws HR-1005. Skipped under test or HR_C4_SELF_CHECK=off. */
export async function runC4StartupCheck(prisma, { logger, env = process.env } = {}) {
    if (env.NODE_ENV === 'test' || env.HR_C4_SELF_CHECK === 'off') {
        logger?.warn?.({ reason: env.NODE_ENV === 'test' ? 'test' : 'HR_C4_SELF_CHECK=off' }, 'C4 start-up self-check skipped');
        return null;
    }
    const result = await verifyC4Decryptable({ sample: prismaSampler(prisma) });
    logger?.info?.(result, 'C4 start-up self-check passed');
    return result;
}
