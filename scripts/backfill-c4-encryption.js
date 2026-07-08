#!/usr/bin/env node
// scripts/backfill-c4-encryption.js — HR-01 / HR-10 (Roadmap T-P4.2)
//
// One-time, IDEMPOTENT backfill that encrypts any existing PLAINTEXT C4 rows
// after the column-type migration (20260624010000_hr_c4_encrypt_at_rest). The
// migration converts the Float salary columns to text but leaves their values
// as the plaintext numeric string; this script replaces each plaintext value
// with its AES-256-GCM envelope and fills the BankDetail blind index.
//
// Design:
//   * Uses a RAW PrismaClient (NOT the src/lib/prisma.js singleton) so it can
//     read the at-rest bytes and write ciphertext WITHOUT the transparent C4
//     extension re-encrypting/decrypting under it. The extension would make a
//     plaintext read look "already plaintext" and a write double-encrypt; the
//     raw client sidesteps both.
//   * Idempotent: rows whose value is ALREADY a c4.v* envelope (isCiphertext)
//     are skipped, so re-running is safe and a partially-migrated table heals.
//   * No-op safe on an empty DB (dev): the loops simply find zero rows.
//   * Fail-closed on a missing key: crypto.js throws HR-1001/HR-1002 before any
//     write, so the script aborts rather than leaving plaintext in place.
//
// Usage:
//   HR_C4_ENCRYPTION_KEY=... HR_C4_BLIND_INDEX_KEY=... \
//     node scripts/backfill-c4-encryption.js
//
// DATABASE_URL selects the target DB (the same env the app uses).
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
    encryptString,
    encryptNumber,
    blindIndex,
    isCiphertext,
} from '../src/lib/crypto.js';

const log = (m) => process.stdout.write(`backfill-c4: ${m}\n`);

const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }), log: ['warn', 'error'] });

let updated = { terms: 0, banks: 0, offers: 0, employees: 0 };

const run = async () => {
    // Touch the keys up front so a misconfiguration fails CLOSED before we
    // mutate anything.
    encryptString('__keycheck__'); // throws HR-1001 if encryption key missing
    blindIndex('__keycheck__'); // throws HR-1002 if blind-index key missing

    // ---- EmploymentTerms: baseSalary, bonusTarget (numeric -> envelope) ----
    const terms = await raw.$queryRaw`SELECT id, "baseSalary", "bonusTarget" FROM employment_terms`;
    for (const t of terms) {
        const data = {};
        if (t.baseSalary != null && !isCiphertext(t.baseSalary)) data.baseSalary = encryptNumber(t.baseSalary);
        if (t.bonusTarget != null && !isCiphertext(t.bonusTarget)) data.bonusTarget = encryptNumber(t.bonusTarget);
        if (Object.keys(data).length) {
            await raw.employmentTerms.update({ where: { id: t.id }, data });
            updated.terms += 1;
        }
    }

    // ---- Offer: salary (numeric -> envelope) ----
    const offers = await raw.$queryRaw`SELECT id, "salary" FROM offers`;
    for (const o of offers) {
        if (o.salary != null && !isCiphertext(o.salary)) {
            await raw.offer.update({ where: { id: o.id }, data: { salary: encryptNumber(o.salary) } });
            updated.offers += 1;
        }
    }

    // ---- Employee: nationality_id_no (string -> envelope) ----
    const employees = await raw.$queryRaw`SELECT id, "nationality_id_no" FROM "Employee" WHERE "nationality_id_no" IS NOT NULL`;
    for (const e of employees) {
        if (e.nationality_id_no != null && !isCiphertext(e.nationality_id_no)) {
            await raw.employee.update({ where: { id: e.id }, data: { nationality_id_no: encryptString(e.nationality_id_no) } });
            updated.employees += 1;
        }
    }

    // ---- BankDetail: accountNumber + routingNumber + blind index ----
    const banks = await raw.$queryRaw`SELECT id, "accountNumber", "routingNumber", "accountNumberBidx" FROM bank_details`;
    for (const b of banks) {
        const data = {};
        // The blind index is derived from the PLAINTEXT account. If the account
        // column is still plaintext, compute the index from it now; if it is
        // already ciphertext we cannot recover the plaintext, so we only fill a
        // missing index when the account is still readable.
        const accountIsPlaintext = b.accountNumber != null && !isCiphertext(b.accountNumber);
        if (accountIsPlaintext && (b.accountNumberBidx == null || b.accountNumberBidx === '')) {
            data.accountNumberBidx = blindIndex(b.accountNumber);
        }
        if (accountIsPlaintext) data.accountNumber = encryptString(b.accountNumber);
        if (b.routingNumber != null && !isCiphertext(b.routingNumber)) data.routingNumber = encryptString(b.routingNumber);
        if (Object.keys(data).length) {
            await raw.bankDetail.update({ where: { id: b.id }, data });
            updated.banks += 1;
        }
    }

    log(
        `done: employment_terms=${updated.terms} offers=${updated.offers} ` +
            `employees=${updated.employees} bank_details=${updated.banks}`,
    );
};

run()
    .catch((err) => {
        process.stderr.write(`backfill-c4: FAILED ${err.message}\n`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await raw.$disconnect();
    });
