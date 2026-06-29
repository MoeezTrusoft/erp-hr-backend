// src/lib/optimisticConcurrency.js — X-07 / ARCH-01 §3.4.
//
// If-Match / 412 optimistic concurrency for HR mutations. HR aggregates do not
// yet carry an integer `version` column (a later additive migration; noted in
// `remaining`), so the entity version is derived DETERMINISTICALLY from the
// row's last-write timestamp (`updated_at` / `updatedAt`) as an epoch-ms
// integer. That integer is a valid contract EntityVersion (positive int) and
// doubles as the row's ETag.
//
// Contract:
//   * versionOf(row)      → the current entity version (int) or null.
//   * parseIfMatch(header) → the caller's expected version (int) or null.
//   * assertIfMatch(expected, row) → throws 412 when `expected` is supplied AND
//     does not match the row's current version (lost-update prevention). When
//     no precondition is supplied the check is a NO-OP — the precondition is
//     opt-in (a client that wants the guarantee sends If-Match).
//
// This prevents the lost-update race: A reads v=N, B reads v=N, B writes (now
// v=M), A writes with If-Match=N → 412 instead of silently clobbering B.

/** A 412 Precondition Failed — surfaced by the route layer as HTTP 412. */
export class PreconditionFailedError extends Error {
    constructor(message = 'Precondition failed: the resource was modified by another writer') {
        super(message);
        this.name = 'PreconditionFailedError';
        this.status = 412;
        this.code = 'HR-0412';
    }
}

/**
 * Derive the current entity version of a row. Prefers an explicit integer
 * `version` column when one exists; otherwise uses the last-write timestamp
 * (`updated_at` or `updatedAt`) as an epoch-ms integer. Returns null when the
 * row carries no version signal at all.
 */
export function versionOf(row) {
    if (!row || typeof row !== 'object') return null;
    if (Number.isInteger(row.version) && row.version > 0) return row.version;

    const ts = row.updated_at ?? row.updatedAt ?? null;
    if (ts == null) return null;
    const ms = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return ms;
}

/**
 * Parse an If-Match header value into the caller's expected version (int).
 * Accepts a bare number ("42"), a quoted ETag ('"42"'), or a weak ETag
 * ('W/"42"'). Returns null when absent or unparseable.
 */
export function parseIfMatch(headerValue) {
    if (headerValue == null) return null;
    const raw = String(headerValue).trim();
    if (!raw) return null;
    // strip weak-validator prefix + surrounding quotes
    const cleaned = raw.replace(/^W\//i, '').replace(/^"(.*)"$/, '$1').trim();
    if (!/^\d+$/.test(cleaned)) return null;
    const n = Number.parseInt(cleaned, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Enforce the If-Match precondition. No-op when `expected` is absent (opt-in).
 * Throws PreconditionFailedError (412) when the expected version is supplied but
 * does not match the row's current version — including the case where the row
 * carries no version at all (a precondition cannot be satisfied, so it fails
 * closed).
 *
 * @param {string|number|null|undefined} expectedRaw  the If-Match header value.
 * @param {object} row                                the current persisted row.
 */
export function assertIfMatch(expectedRaw, row) {
    const expected = typeof expectedRaw === 'number' ? expectedRaw : parseIfMatch(expectedRaw);
    if (expected == null) return; // no precondition requested

    const current = versionOf(row);
    if (current == null) {
        throw new PreconditionFailedError(
            'Precondition failed: the resource has no version to match against'
        );
    }
    if (current !== expected) {
        throw new PreconditionFailedError();
    }
}

/** Format a row's current version as an ETag string for response headers. */
export function etagOf(row) {
    const v = versionOf(row);
    return v == null ? null : `"${v}"`;
}
