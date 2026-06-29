// tests/unit/lib/optimisticConcurrency.test.js
//
// X-07 / ARCH-01 §3.4 — If-Match / 412 optimistic concurrency. HR aggregates
// have no integer version column yet (a later migration), so the entity version
// is derived deterministically from the row's `updated_at` (epoch-ms → a
// positive int that satisfies the contract EntityVersion). A mutation that
// carries an If-Match precondition is rejected with 412 when the caller's
// expected version no longer matches the row's current version (someone else
// wrote in between) — lost-update prevention without a schema change.
import { describe, it, expect } from '@jest/globals';

import {
    versionOf,
    parseIfMatch,
    assertIfMatch,
    PreconditionFailedError,
} from '../../../src/lib/optimisticConcurrency.js';

describe('versionOf', () => {
    it('derives a positive-int version from updated_at', () => {
        const v = versionOf({ updated_at: new Date('2026-06-25T10:00:00.000Z') });
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
    });

    it('prefers an explicit integer version column when present', () => {
        expect(versionOf({ version: 5, updated_at: new Date() })).toBe(5);
    });

    it('supports the camelCase updatedAt field too', () => {
        const v = versionOf({ updatedAt: new Date('2026-06-25T10:00:00.000Z') });
        expect(v).toBeGreaterThan(0);
    });

    it('returns null when the row carries no version signal', () => {
        expect(versionOf({})).toBeNull();
        expect(versionOf(null)).toBeNull();
    });
});

describe('parseIfMatch', () => {
    it('parses a bare numeric token', () => {
        expect(parseIfMatch('1782339600000')).toBe(1782339600000);
    });

    it('parses a quoted ETag', () => {
        expect(parseIfMatch('"42"')).toBe(42);
        expect(parseIfMatch('W/"42"')).toBe(42);
    });

    it('returns null for absent / unparseable values', () => {
        expect(parseIfMatch(undefined)).toBeNull();
        expect(parseIfMatch('')).toBeNull();
        expect(parseIfMatch('not-a-number')).toBeNull();
    });
});

describe('assertIfMatch', () => {
    const row = { updated_at: new Date('2026-06-25T10:00:00.000Z') };
    const current = versionOf(row);

    it('passes when no precondition is supplied (precondition is OPT-IN)', () => {
        expect(() => assertIfMatch(undefined, row)).not.toThrow();
        expect(() => assertIfMatch(null, row)).not.toThrow();
    });

    it('passes when the expected version matches the current row version', () => {
        expect(() => assertIfMatch(String(current), row)).not.toThrow();
        expect(() => assertIfMatch(`"${current}"`, row)).not.toThrow();
    });

    it('throws a 412 PreconditionFailedError when the version is stale', () => {
        const stale = current - 1000;
        let thrown;
        try { assertIfMatch(String(stale), row); } catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(PreconditionFailedError);
        expect(thrown.status).toBe(412);
    });

    it('throws 412 when an If-Match is required but the row has no version', () => {
        let thrown;
        try { assertIfMatch('123', {}); } catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(PreconditionFailedError);
        expect(thrown.status).toBe(412);
    });
});
