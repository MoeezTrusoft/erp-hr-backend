// src/lib/money.js — HR-02 / HR-07 (Roadmap T-P4.1)
//
// Deterministic money arithmetic in INTEGER MINOR UNITS (cents). The legacy
// payroll engine did all math in JS Float (`grossAmount += amount`,
// `baseSalary / 2`, `baseSalary * 12 / 52`), which is non-deterministic at the
// cent: 0.1 + 0.2 !== 0.3, and a salary split into thirds drifts. T-P4.1
// requires a run to be reproducible byte-for-byte, so every payroll figure is
// carried as a safe integer count of minor units and only converted back to a
// major-unit Number at the persistence/display boundary.
//
// ROUNDING MODE: round-half-up (a.k.a. "round half away from zero" for the
// non-negative payroll domain). This is the single, explicit rounding rule for
// the whole engine — `0.5` cents always rounds UP to the next cent. It is
// applied in exactly two places: (1) converting a rate-multiplied amount back
// to whole minor units (`mulRate`), and (2) converting a major-unit input to
// minor units (`fromMajor`). Nowhere else does the engine round, because all
// add/sub stay in integers.
//
// MINOR_PER_MAJOR is fixed at 100 (two-decimal currencies — USD/EUR/etc.). The
// engine's currencies (countryCode/currencyCode on PayrollRun) are all 2dp in
// the seeded/used data; a zero-decimal currency (JPY) would need a per-currency
// exponent — flagged in the report as a follow-on, NOT silently mishandled.

export const MINOR_PER_MAJOR = 100;

const assertSafeInt = (n, label) => {
    if (!Number.isInteger(n) || !Number.isSafeInteger(n)) {
        throw new Error(`HR-2002 money: ${label} must be a safe integer minor-unit value (got ${n})`);
    }
    return n;
};

/**
 * Round-half-up to the nearest integer. Defined explicitly (not Math.round,
 * whose behaviour on negative .5 differs) so the rounding mode is auditable.
 * Half always goes AWAY from zero, which for the non-negative payroll domain is
 * "up". A tiny epsilon guards against a representable value like 2.4999999999998
 * that is mathematically 2.5 having been produced by an exact rational; inputs
 * here come from `rate * integer` so the epsilon is well below one minor unit.
 */
export const roundHalfUp = (value) => {
    if (!Number.isFinite(value)) {
        throw new Error(`HR-2003 money: cannot round non-finite value ${value}`);
    }
    const sign = value < 0 ? -1 : 1;
    const abs = Math.abs(value);
    const floor = Math.floor(abs);
    const frac = abs - floor;
    // Pull frac toward the nearest representable to avoid 0.5 - ε landing below.
    const rounded = frac >= 0.5 - 1e-9 ? floor + 1 : floor;
    return sign * rounded;
};

/**
 * Convert a major-unit amount (e.g. a `baseSalary` Number like 60000 or
 * 1234.567) to integer minor units, rounding half-up at the cent.
 */
export const fromMajor = (major) => {
    if (major === null || major === undefined) {
        throw new Error('HR-2001 money: cannot convert null/undefined to minor units');
    }
    const n = typeof major === 'number' ? major : Number(major);
    if (!Number.isFinite(n)) {
        throw new Error(`HR-2001 money: cannot convert non-finite value ${major} to minor units`);
    }
    return roundHalfUp(n * MINOR_PER_MAJOR);
};

/**
 * Convert integer minor units back to a major-unit Number for the boundary
 * (DB write / API). Exact for safe-integer minor values: cents / 100.
 */
export const toMajor = (minor) => assertSafeInt(minor, 'toMajor input') / MINOR_PER_MAJOR;

/** Sum a list of integer minor-unit values (exact integer addition). */
export const sum = (minors) =>
    minors.reduce((acc, m) => acc + assertSafeInt(m, 'sum element'), 0);

export const add = (a, b) => assertSafeInt(a, 'add a') + assertSafeInt(b, 'add b');
export const sub = (a, b) => assertSafeInt(a, 'sub a') - assertSafeInt(b, 'sub b');

/**
 * Multiply an integer minor-unit amount by a decimal rate (e.g. a 0.15 tax
 * rate or a 0.05 allowance rate) and round half-up to whole minor units. This
 * is THE rounding boundary for rate math — the result is exact integer cents.
 */
export const mulRate = (minor, rate) => {
    assertSafeInt(minor, 'mulRate amount');
    const r = typeof rate === 'number' ? rate : Number(rate);
    if (!Number.isFinite(r)) {
        throw new Error(`HR-2004 money: non-finite rate ${rate}`);
    }
    return roundHalfUp(minor * r);
};

/**
 * Divide an integer minor-unit amount into `parts` equal shares WITHOUT losing
 * a cent: the floor share goes to every part, and the remainder cents are
 * distributed one-per-part to the FIRST `remainder` parts (largest-remainder by
 * position, fully deterministic). Σ(shares) === minor exactly. This is what
 * makes `baseSalary / 2` (SEMI_MONTHLY) and a third-of-salary split exact and
 * total-preserving instead of float-drifting.
 *
 * @returns {number[]} integer minor-unit shares, length === parts.
 */
export const allocateEvenly = (minor, parts) => {
    assertSafeInt(minor, 'allocateEvenly amount');
    if (!Number.isInteger(parts) || parts <= 0) {
        throw new Error(`HR-2005 money: allocate parts must be a positive integer (got ${parts})`);
    }
    const sign = minor < 0 ? -1 : 1;
    const abs = Math.abs(minor);
    const base = Math.floor(abs / parts);
    const remainder = abs - base * parts;
    const shares = [];
    for (let i = 0; i < parts; i += 1) {
        shares.push(sign * (base + (i < remainder ? 1 : 0)));
    }
    return shares;
};

/**
 * Scale an integer minor-unit amount by a rational numerator/denominator
 * (e.g. annual→bi-weekly is *12/52, but the legacy code did float math). We
 * multiply first (exact, within safe-integer range for realistic salaries)
 * then round half-up on the single division — one rounding boundary, total
 * deterministic. minor * num / den, round-half-up.
 */
export const scaleRational = (minor, num, den) => {
    assertSafeInt(minor, 'scaleRational amount');
    if (!Number.isInteger(num) || !Number.isInteger(den) || den === 0) {
        throw new Error(`HR-2006 money: scaleRational needs integer num/den, den!=0 (got ${num}/${den})`);
    }
    const product = minor * num;
    if (!Number.isSafeInteger(product)) {
        throw new Error('HR-2007 money: scaleRational product exceeds safe-integer range');
    }
    return roundHalfUp(product / den);
};

export default {
    MINOR_PER_MAJOR,
    roundHalfUp,
    fromMajor,
    toMajor,
    sum,
    add,
    sub,
    mulRate,
    allocateEvenly,
    scaleRational,
};
