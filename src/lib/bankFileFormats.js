// src/lib/bankFileFormats.js — HR-BANKFILE-03 / HR-PAY-04
//
// PURE, side-effect-free formatters that turn a list of disbursement rows into
// a bank file. No prisma, no logging, no decryption — the caller (bankFileService)
// owns tenancy, status gating, C4 decryption and the never-log-account-numbers
// contract. These functions just lay bytes out per a wire format so they are
// trivially unit-testable and reusable.
//
// Two formats:
//   * NACHA ACH (US) — the fixed-width 94-char/record interbank file (File
//     Header → Batch Header → Entry Detail per employee → Batch Control →
//     File Control, padded to a 10-record block). Fully implemented.
//   * Bank CSV — a configurable, human/bank-readable delimited file. Fully
//     implemented. New formats register in FORMATTERS below (the extension
//     point): add a builder + descriptor and the service can select it.
//
// A "row" is the shape the service produces from a payslip + the employee's
// (decrypted, in-memory) primary bank detail:
//   { employeeId, name, routingNumber, accountNumber, accountType, amountMinor, currency }
// amountMinor is the NET pay in integer minor units (cents) — never a Float.

const RECORD_LENGTH = 94;
const BLOCKING_FACTOR = 10;

// ── small fixed-width helpers ───────────────────────────────────────────────
const digitsOnly = (s) => String(s ?? '').replace(/\D/g, '');

// Left-justified, space-padded, hard-truncated to `len` (NACHA alphameric).
const padRight = (s, len) => String(s ?? '').slice(0, len).padEnd(len, ' ');

// Right-justified, zero-filled numeric field of width `len` (last `len` digits).
const numField = (n, len) => {
    const d = digitsOnly(n);
    return d.slice(-len).padStart(len, '0');
};

// NACHA names/descriptions are uppercase alphameric; strip the rest.
const alnumUpper = (s, len) =>
    padRight(String(s ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ''), len);

// CHECKING credit = 22, SAVINGS credit = 32 (ACH transaction codes).
const transactionCode = (accountType) =>
    String(accountType ?? '').toUpperCase().startsWith('SAV') ? '32' : '22';

const yymmdd = (date) => {
    const d = date instanceof Date ? date : new Date(date);
    const yy = String(d.getUTCFullYear()).slice(-2);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
};

const hhmm = (date) => {
    const d = date instanceof Date ? date : new Date(date);
    return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/**
 * Build a NACHA ACH (PPD credit) file from disbursement rows.
 * @param {Array<object>} rows
 * @param {object} [opts]
 *   companyName, companyId (10-char originator id, e.g. EIN), originName,
 *   originatingDfi (9-digit ODFI routing), immediateDestination (10-char),
 *   immediateOrigin (10-char), entryDescription, effectiveDate, fileCreation
 * @returns {string} the assembled file (\n-joined fixed-width records)
 */
export const buildNachaFile = (rows, opts = {}) => {
    const created = opts.fileCreation ? new Date(opts.fileCreation) : new Date();
    const effective = opts.effectiveDate ? new Date(opts.effectiveDate) : created;

    const odfi = numField(opts.originatingDfi || opts.immediateOrigin || '000000000', 9);
    const odfi8 = odfi.slice(0, 8); // Originating DFI id (8 digits) + trace prefix
    const immediateDest = opts.immediateDestination
        ? padRight(opts.immediateDestination, 10)
        : ` ${numField(opts.originatingDfi || '000000000', 9)}`;
    const immediateOrig = opts.immediateOrigin
        ? padRight(opts.immediateOrigin, 10)
        : ` ${numField(opts.companyId || odfi, 9)}`;
    const serviceClass = '220'; // credits only

    const lines = [];

    // 1 — File Header
    lines.push(
        '1' +
        '01' +
        immediateDest +
        immediateOrig +
        yymmdd(created) +
        hhmm(created) +
        'A' +
        '094' +
        '10' +
        '1' +
        alnumUpper(opts.immediateDestinationName || opts.companyName || 'BANK', 23) +
        alnumUpper(opts.originName || opts.companyName || 'COMPANY', 23) +
        padRight('', 8),
    );

    // 5 — Batch Header
    lines.push(
        '5' +
        serviceClass +
        alnumUpper(opts.companyName || 'COMPANY', 16) +
        padRight('', 20) +
        padRight(opts.companyId || odfi, 10) +
        'PPD' +
        alnumUpper(opts.entryDescription || 'PAYROLL', 10) +
        yymmdd(created) +
        yymmdd(effective) +
        '   ' +
        '1' +
        odfi8 +
        numField('1', 7),
    );

    // 6 — Entry Detail (one per disbursement)
    let entryHash = 0;
    let creditTotal = 0;
    rows.forEach((row, i) => {
        const rdfi = numField(row.routingNumber, 9);
        const rdfi8 = rdfi.slice(0, 8);
        const checkDigit = rdfi.slice(8, 9);
        entryHash += Number(rdfi8);
        creditTotal += Number(row.amountMinor) || 0;
        lines.push(
            '6' +
            transactionCode(row.accountType) +
            rdfi8 +
            checkDigit +
            padRight(row.accountNumber, 17) +
            numField(String(Math.round(row.amountMinor)), 10) +
            padRight(String(row.employeeId ?? ''), 15) +
            alnumUpper(row.name || '', 22) +
            '  ' +
            '0' +
            odfi8 + numField(String(i + 1), 7),
        );
    });
    const hashMod = String(entryHash % 1e10).padStart(10, '0');

    // 8 — Batch Control
    lines.push(
        '8' +
        serviceClass +
        numField(String(rows.length), 6) +
        hashMod +
        numField('0', 12) + // total debit
        numField(String(creditTotal), 12) +
        padRight(opts.companyId || odfi, 10) +
        padRight('', 19) +
        padRight('', 6) +
        odfi8 +
        numField('1', 7),
    );

    // 9 — File Control
    const entryAddendaCount = rows.length;
    // record count so far = 1 header + 1 batch header + N entries + 1 batch ctrl
    const recordsBeforeFileCtrl = lines.length + 1; // + the file control itself
    const blockCount = Math.ceil(recordsBeforeFileCtrl / BLOCKING_FACTOR);
    lines.push(
        '9' +
        numField('1', 6) + // batch count
        numField(String(blockCount), 6) +
        numField(String(entryAddendaCount), 8) +
        hashMod +
        numField('0', 12) +
        numField(String(creditTotal), 12) +
        padRight('', 39),
    );

    // Pad with all-9 records to fill the final block (blocking factor 10).
    const filler = '9'.repeat(RECORD_LENGTH);
    while (lines.length % BLOCKING_FACTOR !== 0) lines.push(filler);

    return lines.join('\n');
};

const csvEscape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Build a configurable bank CSV from disbursement rows. The amount is rendered
 * in major units (cents/100) with two decimals at the boundary.
 * @returns {string}
 */
export const buildBankCsv = (rows, opts = {}) => {
    const header = [
        'employee_id',
        'employee_name',
        'routing_number',
        'account_number',
        'account_type',
        'currency',
        'amount',
    ];
    const body = rows.map((r) =>
        [
            r.employeeId ?? '',
            r.name ?? '',
            r.routingNumber ?? '',
            r.accountNumber ?? '',
            (r.accountType || 'CHECKING').toUpperCase(),
            r.currency || opts.currency || 'USD',
            (Number(r.amountMinor) / 100).toFixed(2),
        ]
            .map(csvEscape)
            .join(','),
    );
    return [header.join(','), ...body].join('\n');
};

// Registry / EXTENSION POINT: format key → { build, ext, contentType }. New
// bank formats (BACS, SEPA pain.001, a specific bank's proprietary CSV) plug in
// here without the service changing.
export const FORMATTERS = {
    nacha: { build: buildNachaFile, ext: 'ach', contentType: 'text/plain' },
    ach: { build: buildNachaFile, ext: 'ach', contentType: 'text/plain' },
    csv: { build: buildBankCsv, ext: 'csv', contentType: 'text/csv' },
};

export const isSupportedFormat = (format) =>
    Object.prototype.hasOwnProperty.call(FORMATTERS, String(format).toLowerCase());

export default { buildNachaFile, buildBankCsv, FORMATTERS, isSupportedFormat };
