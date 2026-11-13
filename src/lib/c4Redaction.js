// src/lib/c4Redaction.js — HR-01 / HR-10 (Roadmap T-P4.2)
//
// Central registry of C4 (most-sensitive) field names and a deep redactor for
// audit diffs. payrollService writes payrollAuditLog.oldValues/newValues via
// JSON.stringify(...) of whole payroll runs (payrollService.js ~L237-238); a
// raw run carries grossAmount/netAmount/totalDeductions and nested
// salary/bank/national-id. Stringifying it verbatim would persist plaintext C4
// into the audit table — exactly what T-P4.2 forbids. `redactC4` walks an
// object/array tree and replaces any C4-named field with a censor token BEFORE
// it is serialized.
//
// The pino redaction in src/lib/logger.js handles structured log lines; this
// helper handles the audit-diff JSON blobs that do not flow through pino.

export const C4_CENSOR = '[C4-REDACTED]';

// Field names considered C4 wherever they appear in an object tree. Kept in
// one place so logger redaction, audit-diff redaction, and the encryption
// extension all agree on the surface.
export const C4_FIELD_NAMES = new Set([
    // salary / compensation
    'baseSalary',
    'bonusTarget',
    'salary',
    'grossAmount',
    'netAmount',
    'totalDeductions',
    'totalGross',
    'totalNet',
    // bank
    'accountNumber',
    'routingNumber',
    // national id
    'nationality_id_no',
]);

/**
 * Deep-clone `value`, replacing any property whose key is a C4 field name with
 * the censor token. Arrays are walked element-wise. Dates and other non-plain
 * objects are returned by value (we only descend into plain objects/arrays).
 * Pure — does not mutate the input. Safe on cyclic-free trees (audit payloads
 * are JSON-serializable by construction).
 */
export const redactC4 = (value) => {
    if (Array.isArray(value)) return value.map((item) => redactC4(item));
    if (value && typeof value === 'object') {
        // Leave non-plain objects (Date, Buffer, etc.) intact.
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) return value;

        const out = {};
        for (const [key, val] of Object.entries(value)) {
            if (C4_FIELD_NAMES.has(key)) {
                out[key] = val === null || val === undefined ? val : C4_CENSOR;
            } else {
                out[key] = redactC4(val);
            }
        }
        return out;
    }
    return value;
};

/**
 * Convenience for the audit path: redact then JSON.stringify in one step, so
 * call sites can drop in `redactC4Json(run)` where they had
 * `JSON.stringify(run)`.
 */
export const redactC4Json = (value) => JSON.stringify(redactC4(value));

export default { C4_CENSOR, C4_FIELD_NAMES, redactC4, redactC4Json };
