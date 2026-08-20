// HR-ATT-DEVICE-INTAKE-01 — parser for the ADMS/iclock ATTLOG rows the MB460
// Plus pushes. Pure function, no DB. Rows captured live from SN TTQ5261300360.
import { describe, it, expect } from '@jest/globals';
import { parseAttlogRow } from '../../src/services/attendance.device-intake.service.js';

describe('HR-ATT-DEVICE-INTAKE-01 parseAttlogRow', () => {
    it('parses a real check-in row (status 0, face verify 15)', () => {
        const row = '3111\t2026-08-20 14:20:35\t0\t15\t0\t0\t0\t0\t0\t0\t';
        const p = parseAttlogRow(row);
        expect(p).not.toBeNull();
        expect(p.deviceUserId).toBe('3111');
        expect(p.status).toBe(0);
        expect(p.verifyMode).toBe(15);
        expect(p.workCode).toBe(0);
        expect(p.punchedAt.getFullYear()).toBe(2026);
        expect(p.rawLine).toBe(row);
    });

    it('parses a check-out row (status 1, fingerprint verify 1)', () => {
        const p = parseAttlogRow('3111\t2026-08-20 02:44:13\t1\t1\t0');
        expect(p.status).toBe(1);
        expect(p.verifyMode).toBe(1);
    });

    it('returns null when the timestamp is missing or unparseable', () => {
        expect(parseAttlogRow('3111\t\t0\t15')).toBeNull();
        expect(parseAttlogRow('3111\tnot-a-date\t0\t15')).toBeNull();
    });

    it('returns null when the device user id is empty', () => {
        expect(parseAttlogRow('\t2026-08-20 14:20:35\t0\t15')).toBeNull();
    });

    it('returns null for non-string input', () => {
        expect(parseAttlogRow(null)).toBeNull();
        expect(parseAttlogRow(42)).toBeNull();
    });

    it('defaults missing numeric columns to 0 rather than NaN', () => {
        const p = parseAttlogRow('3111\t2026-08-20 14:20:35');
        expect(p.status).toBe(0);
        expect(p.verifyMode).toBe(0);
        expect(p.workCode).toBe(0);
    });
});
