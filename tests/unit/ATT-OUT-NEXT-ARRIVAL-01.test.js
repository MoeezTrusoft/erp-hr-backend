// ATT-OUT-NEXT-ARRIVAL-01 — a crew that keys OUT for every scan (issue 342, Aurangzaib 19-21 Oct 2026).
// The 09:38 arrival keyed OUT was claimed by the previous day as a second check-out.
import { describe, it, expect } from '@jest/globals';
import { sessioniseByRoster } from '../../src/lib/attendanceReplay.js';

const DAY = { type: 'weekly', shift: { from: '10:00', to: '22:00' }, offDays: [5, 6] };
const NIGHT = { type: 'weekly', shift: { from: '15:00', to: '00:00' }, offDays: [6, 7] };
const at = (d, hhmm) => new Date(`2026-10-${d}T${hhmm}:00.000Z`);
const punch = (d, hhmm, status) => ({ punchedAt: at(d, hhmm), status, trustDirection: true });
const days = (sessions) => sessions.map((s) => [s.day.toISOString().slice(8, 10), s.punches.map((p) => p.timestamp.toISOString().slice(8, 16).replace('T', ' '))]);

describe('explicit OUT shortly before a rostered start', () => {
  it('belongs to the next shift once the previous one already has its OUT', () => {
    const sessions = sessioniseByRoster([
      punch('19', '09:41', 0), punch('19', '22:06', 1),
      punch('20', '09:38', 1), punch('20', '22:00', 1),
      punch('21', '09:45', 1), punch('21', '22:01', 1),
    ], DAY);
    expect(days(sessions)).toEqual([
      ['19', ['19 09:41', '19 22:06']],
      ['20', ['20 09:38', '20 22:00']],
      ['21', ['21 09:45', '21 22:01']],
    ]);
  });

  it('still lets a late OUT close an overnight shift (15:00-00:00 crew leaving at 08:30)', () => {
    const sessions = sessioniseByRoster([punch('19', '15:02', 0), punch('20', '08:30', 1)], NIGHT);
    expect(days(sessions)).toEqual([['19', ['19 15:02', '20 08:30']]]);
  });

  it('does not move an OUT that is the only close of the previous shift', () => {
    const sessions = sessioniseByRoster([punch('19', '09:41', 0), punch('20', '09:38', 1)], DAY);
    expect(days(sessions)[0]).toEqual(['19', ['19 09:41', '20 09:38']]);
  });
});
