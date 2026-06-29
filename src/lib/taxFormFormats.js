// src/lib/taxFormFormats.js — HR-PAY-07 / HR-SEC-05 (statutory year-end forms)
//
// PURE, side-effect-free formatters that turn a list of statutory tax-form
// records into an exportable artifact. No prisma, no logging, no decryption —
// the caller (taxFormService) owns tenancy, the FINALIZED-run aggregation, C4
// (SSN/EIN) decryption and the never-log-the-identifier contract. These
// functions just lay bytes out per an output format so they are trivially
// unit-testable and reusable.
//
// Implemented formats:
//   * W-2 CSV     — one row per employee with the computed W-2 box totals.
//   * 1099-NEC CSV — one row per contractor with the computed 1099-NEC boxes.
//     Both CSV formats are FULLY implemented and are the concrete export.
//
// EXTENSION POINT (NOT implemented here, by design):
//   * IRS EFW2 (SSA BSO) fixed-width employee-wage file and the 1099 fixed-width
//     "Publication 1220" record layout. These are large, versioned, statutory
//     wire layouts (RA/RW/RT records, etc.); the structured records this module
//     consumes carry every field they need, so a future builder can be added to
//     EFW2_LAYOUTS without touching the service. Until then `buildEfw2` throws a
//     clear not-implemented error so the gap is explicit, never silently empty.
//
// A "record" is the statutory shape taxFormService produces per recipient:
//   {
//     formType, taxYear, currency,
//     payer:     { name, ein, tenantId, ... },
//     recipient: { employeeId, employeeCode, name, tin, tinType,
//                  address: { street, city, state, postalCode, country } },
//     boxes:     { ...form-specific box totals (major-unit Numbers) },
//     reconciliation: { grossPay, totalDeductions, netPay, payslipCount, runIds }
//   }

// ── CSV helpers ──────────────────────────────────────────────────────────────
// Minimal RFC-4180 field quoting: wrap in quotes and double internal quotes
// when the value contains a comma, quote or newline. Numbers/null render plain.
const csvField = (value) => {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
};

const csvLine = (cells) => cells.map(csvField).join(',');

// Major-unit money for CSV: always two decimals (statutory forms are 2dp).
const money2 = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '0.00');

const addr = (recipient) => recipient?.address ?? {};

// ── W-2 CSV ──────────────────────────────────────────────────────────────────
const W2_HEADER = [
    'tax_year',
    'employee_id',
    'employee_code',
    'employee_name',
    'ssn',
    'address',
    'city',
    'state',
    'postal_code',
    'country',
    'box1_wages_tips_other_comp',
    'box2_federal_income_tax_withheld',
    'box3_social_security_wages',
    'box4_social_security_tax_withheld',
    'box5_medicare_wages_and_tips',
    'box6_medicare_tax_withheld',
    'box16_state_wages',
    'box17_state_income_tax',
    'currency',
];

const w2Row = (rec) => {
    const b = rec.boxes ?? {};
    const a = addr(rec.recipient);
    return csvLine([
        rec.taxYear,
        rec.recipient?.employeeId,
        rec.recipient?.employeeCode,
        rec.recipient?.name,
        rec.recipient?.tin, // decrypted SSN — present ONLY in the export artifact
        a.street,
        a.city,
        a.state,
        a.postalCode,
        a.country,
        money2(b.box1_wagesTipsOtherComp),
        money2(b.box2_federalIncomeTaxWithheld),
        money2(b.box3_socialSecurityWages),
        money2(b.box4_socialSecurityTaxWithheld),
        money2(b.box5_medicareWagesAndTips),
        money2(b.box6_medicareTaxWithheld),
        money2(b.box16_stateWages),
        money2(b.box17_stateIncomeTax),
        rec.currency,
    ]);
};

export const buildW2Csv = (records = []) =>
    [csvLine(W2_HEADER), ...records.map(w2Row)].join('\n') + '\n';

// ── 1099-NEC CSV ─────────────────────────────────────────────────────────────
const NEC_HEADER = [
    'tax_year',
    'recipient_id',
    'recipient_code',
    'recipient_name',
    'tin',
    'tin_type',
    'address',
    'city',
    'state',
    'postal_code',
    'country',
    'box1_nonemployee_compensation',
    'box4_federal_income_tax_withheld',
    'currency',
];

const necRow = (rec) => {
    const b = rec.boxes ?? {};
    const a = addr(rec.recipient);
    return csvLine([
        rec.taxYear,
        rec.recipient?.employeeId,
        rec.recipient?.employeeCode,
        rec.recipient?.name,
        rec.recipient?.tin, // decrypted TIN/EIN — present ONLY in the export artifact
        rec.recipient?.tinType,
        a.street,
        a.city,
        a.state,
        a.postalCode,
        a.country,
        money2(b.box1_nonemployeeCompensation),
        money2(b.box4_federalIncomeTaxWithheld),
        rec.currency,
    ]);
};

export const build1099NecCsv = (records = []) =>
    [csvLine(NEC_HEADER), ...records.map(necRow)].join('\n') + '\n';

// ── EFW2 / 1099 fixed-width (EXTENSION POINT) ────────────────────────────────
export const buildEfw2 = () => {
    throw Object.assign(
        new Error(
            'HR-1402 IRS EFW2 (SSA BSO) / 1099 fixed-width layout is not implemented; '
            + 'use a CSV export. Add a builder to EFW2_LAYOUTS to enable the statutory wire format.',
        ),
        { status: 501, statusCode: 501, code: 'HR-1402' },
    );
};

// Registry of statutory wire layouts. Empty by design — the documented
// extension point. A future contributor registers e.g. { build: fn, ext, contentType }.
export const EFW2_LAYOUTS = {};

// ── format registry ──────────────────────────────────────────────────────────
// formType → format key → { build(records), ext, contentType }.
export const TAX_FORM_FORMATTERS = {
    'W-2': {
        csv: { build: buildW2Csv, ext: 'csv', contentType: 'text/csv' },
    },
    '1099-NEC': {
        csv: { build: build1099NecCsv, ext: 'csv', contentType: 'text/csv' },
    },
};

export const isSupportedExport = (formType, format) =>
    Boolean(TAX_FORM_FORMATTERS[formType]?.[String(format).toLowerCase()]);

export default {
    buildW2Csv,
    build1099NecCsv,
    buildEfw2,
    EFW2_LAYOUTS,
    TAX_FORM_FORMATTERS,
    isSupportedExport,
};
