// N-12 — the attendance importer must not turn rest days into ABSENT.
//
// validateRow derives status='ABSENT' whenever the day type is WEEKLY_OFF /
// HOLIDAY / LEAVE ("an absence is indistinguishable from a Sunday" — the exact
// confusion this test forbids), and the upsert then drops day_type entirely.
// Imported Sundays would land as plain ABSENT rows: post-N-09 they are skipped
// by the payroll bridge only because the STATUS says WEEKLY_OFF — which this
// bug never stores. The stored status must carry the day type, exactly like
// the device writer restates rest days (WEEKLY_OFF / HOLIDAY / ON_LEAVE).
import { describe, it, expect } from '@jest/globals';
import { validateRow } from '../../src/services/attendanceImport.service.js';

const lookup = { byCode: new Map([['emp-1', 11]]) };
const fresh = () => new Set();
const row = (over = {}) => ({
    employee_code: 'EMP-1', date: '2026-08-02',
    day_type: 'WORKING', status: '', check_in: '09:00', check_out: '18:00',
    ...over,
});

describe('N-12 importer stores the day type as the row status', () => {
    it('WEEKLY_OFF rows keep status WEEKLY_OFF (not ABSENT)', () => {
        const v = validateRow(row({ day_type: 'WEEKLY_OFF', check_in: '', check_out: '' }), lookup, fresh());
        expect(v.ok).toBe(true);
        expect(v.value.status).toBe('WEEKLY_OFF');
    });

    it('HOLIDAY rows keep status HOLIDAY', () => {
        const v = validateRow(row({ day_type: 'HOLIDAY', check_in: '', check_out: '' }), lookup, fresh());
        expect(v.ok).toBe(true);
        expect(v.value.status).toBe('HOLIDAY');
    });

    it('LEAVE rows become ON_LEAVE (the device writer convention)', () => {
        const v = validateRow(row({ day_type: 'LEAVE', leave_type: 'CASUAL', check_in: '', check_out: '' }), lookup, fresh());
        expect(v.ok).toBe(true);
        expect(v.value.status).toBe('ON_LEAVE');
    });

    it('synonyms map the same way (weekly off / holiday / on leave)', () => {
        const v = validateRow(row({ day_type: 'weekly off', check_in: '', check_out: '' }), lookup, fresh());
        expect(v.value.status).toBe('WEEKLY_OFF');
        const h = validateRow(row({ day_type: 'public holiday', check_in: '', check_out: '' }), lookup, new Set());
        expect(h.value.status).toBe('HOLIDAY');
    });

    it('a WORKING day with punches still derives PRESENT, and punchless stays ABSENT', () => {
        const p = validateRow(row({}), lookup, new Set());
        expect(p.value.status).toBe('PRESENT');
        const a = validateRow(row({ check_in: '', check_out: '' }), lookup, new Set());
        expect(a.value.status).toBe('ABSENT');
    });

    it('an explicit status on a WORKING day is honored as before', () => {
        const v = validateRow(row({ status: 'HALF_DAY' }), lookup, new Set());
        expect(v.value.status).toBe('HALF_DAY');
    });
});
