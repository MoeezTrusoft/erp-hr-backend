// ATT-DIRECTION-REPAIR-01 — Homenet wrong-key repair (issue 339). Pure functions, fixtures are the inputs.
import { describe, it, expect } from '@jest/globals';
import { evaluateShift } from '../../src/lib/attendanceEvaluator.js';
import { repairDirection } from '../../src/lib/attendanceDirectionRepair.js';

const at = (iso) => new Date(iso);
const POLICY = { graceMinutes: 5, halfDayAfterPercentOfShift: 50, earlyLeaveGraceMin: 0, checkoutLeniencyMin: 240,
  fullDayMinPercent: 90, halfDayMinPercent: 50, duplicatePunchWindowMin: 5 };
const NOW = at('2026-11-02T00:00:00Z');
const DAY = { start: at('2026-10-07T11:00:00Z'), end: at('2026-10-07T21:00:00Z') };
const P = (iso, type) => ({ timestamp: at(iso), type });
const run = (punches, shift = DAY) => {
  const args = { punches, shift, policy: POLICY, now: NOW, credits: [] };
  return { args, verdict: evaluateShift(args) };
};

describe('repairDirection', () => {
  it('repairs OUT at the start and OUT at the end (Arif 7 Oct)', () => {
    const { args, verdict } = run([P('2026-10-07T10:05:00Z', 'OUT'), P('2026-10-07T22:00:00Z', 'OUT')]);
    expect(verdict.status).toBe('MISSING_CHECKIN');
    const fixed = repairDirection({ ...args, verdict });
    expect(fixed.verdict.status).toMatch(/PRESENT|LATE/);
    expect(fixed.verdict.directionRepaired).toBe(true);
    expect(fixed.corrections).toHaveLength(1);
    expect(fixed.corrections[0]).toMatchObject({ recordedAs: 'OUT', resolvedTo: 'IN' });
  });

  it('repairs IN at the start and IN at the end', () => {
    const { args, verdict } = run([P('2026-10-07T10:58:00Z', 'IN'), P('2026-10-07T21:02:00Z', 'IN')]);
    expect(verdict.status).toBe('MISSING_CHECKOUT');
    const fixed = repairDirection({ ...args, verdict });
    expect(fixed.verdict.checkOut).toEqual(at('2026-10-07T21:02:00Z'));
    expect(fixed.corrections[0]).toMatchObject({ recordedAs: 'IN', resolvedTo: 'OUT' });
  });

  it('never touches a day that is already complete', () => {
    const { args, verdict } = run([P('2026-10-07T11:00:00Z', 'IN'), P('2026-10-07T21:00:00Z', 'OUT')]);
    expect(repairDirection({ ...args, verdict })).toBeNull();
  });

  it('leaves a lone departure at the end of the shift alone', () => {
    const { args, verdict } = run([P('2026-10-07T22:01:00Z', 'OUT')]);
    expect(repairDirection({ ...args, verdict })).toBeNull();
  });

  it('reads a lone OUT at the very start as the arrival: one charge, not two (Pervaiz 26 Oct)', () => {
    const shift = { start: at('2026-10-26T10:00:00Z'), end: at('2026-10-26T18:00:00Z') };
    const { args, verdict } = run([P('2026-10-26T09:51:48Z', 'OUT')], shift);
    expect(verdict.anomalies.map((a) => a.type)).toEqual(expect.arrayContaining(['MISSING_CHECKIN', 'EARLY_CHECKOUT']));
    const fixed = repairDirection({ ...args, verdict });
    expect(fixed.verdict.status).toBe('MISSING_CHECKOUT');
    expect(fixed.verdict.anomalies.map((a) => a.type)).toEqual(['MISSING_CHECKOUT']);
    expect(fixed.corrections[0]).toMatchObject({ recordedAs: 'OUT', resolvedTo: 'IN' });
  });

  it('reads a late lone OUT 21 minutes into a night shift as the arrival (Syed Wajahat 2 Oct)', () => {
    const shift = { start: at('2026-10-02T22:00:00Z'), end: at('2026-10-03T10:00:00Z') };
    const { args, verdict } = run([P('2026-10-02T22:21:59Z', 'OUT')], shift);
    const fixed = repairDirection({ ...args, verdict });
    expect(fixed.verdict.anomalies.map((a) => a.type)).toEqual(expect.arrayContaining(['MISSING_CHECKOUT', 'LATE_CHECKIN']));
    expect(fixed.verdict.anomalies.map((a) => a.type)).not.toContain('EARLY_CHECKOUT');
  });

  it('reads a lone IN after the shift end as the departure (Habib Zaidi 6 Oct)', () => {
    const shift = { start: at('2026-10-06T10:00:00Z'), end: at('2026-10-06T18:00:00Z') };
    const { args, verdict } = run([P('2026-10-06T18:46:00Z', 'IN')], shift);
    expect(verdict.anomalies.map((a) => a.type)).toContain('LATE_CHECKIN');
    const fixed = repairDirection({ ...args, verdict });
    expect(fixed.verdict.anomalies.map((a) => a.type)).toEqual(['MISSING_CHECKIN']);
  });

  it('leaves a lone IN at the start and a lone OUT in the middle alone', () => {
    const a = run([P('2026-10-07T11:00:00Z', 'IN')]);
    expect(repairDirection({ ...a.args, verdict: a.verdict })).toBeNull();
    const b = run([P('2026-10-07T15:00:00Z', 'OUT')]);
    expect(repairDirection({ ...b.args, verdict: b.verdict })).toBeNull();
  });

  it('does not repair when the scans are not at opposite ends of the shift', () => {
    const { args, verdict } = run([P('2026-10-07T11:00:00Z', 'IN'), P('2026-10-07T11:30:00Z', 'IN')]);
    expect(repairDirection({ ...args, verdict })).toBeNull();
  });

  it('does not override a verified or manual direction', () => {
    const { args, verdict } = run([
      { ...P('2026-10-07T10:05:00Z', 'OUT'), directionVerified: true }, P('2026-10-07T22:00:00Z', 'OUT')]);
    expect(repairDirection({ ...args, verdict })).toBeNull();
  });
});
