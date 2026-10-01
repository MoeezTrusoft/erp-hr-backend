// ATT-CLOSE-9H-01 / HR-ATT-DIRECTION-02 — a same-shift departure recorded by
// the device closes its own shift even when it lands far past the rostered
// end, and the pairing window reaches nine hours.
//
// Trusoft, 30 Sep–1 Oct 2026: Moeez (device 3111) and Subhan (3118) work the
// 15:00–00:00 roster. They scanned IN at 15:04/14:28 and OUT at 08:30 the next
// morning — 8.5h past the rostered end. The 8h close window refused those
// OUTs, so each opened a phantom 1 Oct session that began with a departure;
// the real 1 Oct arrivals (14:35/14:56) then paired against them and the
// morning departure was stored as the new day's check-in — "we checked out on
// 1 Oct at 08:30 for the shift of 30 Sep". The close window is now nine hours
// (HR: nobody stays more than nine hours past shift end) and a device check-
// OUT closes the open shift inside that window even when position would have
// called it an arrival — the device direction is validated (HR-ATT-POLICY-01,
// 4404 rows, zero disagreements).
import { describe, it, expect } from '@jest/globals';
import { sessioniseByRoster } from '../../src/lib/attendanceReplay.js';

const EVENING = { type: 'weekly', offDays: [], shift: { from: '15:00', to: '00:00' } };
const DAY = { type: 'weekly', offDays: [], shift: { from: '09:00', to: '17:00' } };

const at = (iso, hhmm, status = 0) => ({ punchedAt: new Date(`${iso}T${hhmm}:00.000Z`), status });
const dayOf = (s) => s.day.toISOString().slice(0, 10);
const times = (s) => s.punches.map((p) => p.timestamp.toISOString().slice(11, 16));

describe('ATT-CLOSE-9H-01 a nine-hour-later device check-out closes its own shift', () => {
  it('keeps Moeez 30 Sep 15:04 -> 1 Oct 08:30 as ONE shift (production regression)', () => {
    // Exact production punches, including the OUT code (status 1) the device
    // recorded for the 08:30 morning departure.
    const sessions = sessioniseByRoster([
      at('2026-09-30', '15:04'),
      at('2026-10-01', '08:30', 1),
      at('2026-10-01', '14:56'),
    ], EVENING);

    expect(sessions).toHaveLength(2);
    expect(dayOf(sessions[0])).toBe('2026-09-30');
    expect(times(sessions[0])).toEqual(['15:04', '08:30']);
    // The 1 Oct session holds only the genuine arrival — no phantom opener.
    expect(dayOf(sessions[1])).toBe('2026-10-01');
    expect(times(sessions[1])).toEqual(['14:56']);
  });

  it('closes Subhan 14:28 -> 06:57 -> next-day arrival the same way', () => {
    const sessions = sessioniseByRoster([
      at('2026-09-29', '14:57'),
      at('2026-09-30', '06:57', 1),
      at('2026-09-30', '14:28'),
    ], EVENING);

    expect(sessions.map(dayOf)).toEqual(['2026-09-29', '2026-09-30']);
    expect(times(sessions[0])).toEqual(['14:57', '06:57']);
  });

  it('still refuses a punch beyond the nine-hour window', () => {
    // 09:30 is 9.5h past a 00:00 end — past closeTol, opens its own session
    // exactly as before the change.
    const sessions = sessioniseByRoster([
      at('2026-09-30', '15:04'),
      at('2026-10-01', '09:30', 1),
    ], EVENING);

    expect(sessions.map(dayOf)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('does NOT swallow a genuine morning arrival that a device OUT stamp mangled', () => {
    // A day-shift employee scans IN at 09:02, out 17:04, and next morning
    // arrives 08:58 — the device mis-stamps it OUT (status 1). It sits 15.9h
    // from the previous end but minutes from the 09:00 start, so the
    // nearest-start guard wins and it OPENS the next shift.
    const sessions = sessioniseByRoster([
      at('2026-08-10', '09:02'),
      at('2026-08-10', '17:04'),
      at('2026-08-11', '08:58', 1),
    ], DAY);

    expect(sessions).toHaveLength(2);
    expect(dayOf(sessions[1])).toBe('2026-08-11');
  });

  it('keeps the untyped late departure closing its shift (TOLERANCE-01 unchanged)', () => {
    // hamza's original case: no device direction, position must still close.
    const sessions = sessioniseByRoster(
      [at('2026-08-07', '14:46'), at('2026-08-08', '05:06')],
      EVENING,
    );

    expect(sessions).toHaveLength(1);
    expect(times(sessions[0])).toEqual(['14:46', '05:06']);
  });
});
