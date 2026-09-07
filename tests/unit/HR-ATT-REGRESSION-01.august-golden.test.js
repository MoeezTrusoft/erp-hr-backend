// HR-ATT-REGRESSION-01 — August 2026, frozen.
//
// Every sessionisation defect this month was found by hand: exporting punches
// from production, re-deriving attendance, and comparing the totals against the
// workbook HR closed the month on. That found real bugs — duplicate scans
// inventing shifts, the window edge stranding night shifts, rest-day rows that
// regenerated after deletion — but it is not repeatable, and the next change
// would have had to rediscover them the same way.
//
// So the real data is frozen here. 14 employees, 898 punches, 390 sessions,
// chosen because each one exposed a distinct defect:
//
//   EMP165 Khurram      every scan recorded 3-4x (HR-ATT-DUPLICATE-01)
//   EMP162/168/172      rotating roster, rest days (HR-ATT-ROTATING-03)
//   EMP221 hamza        departure past the closing tolerance
//   EMP197/204          night shift closing the next morning
//   EMP211 Faique       shift crossing midnight
//   EMP183 Imam Bakhsh  23:00-09:00, both ends in different days
//   EMP171 Rustam       12h+ shift
//   EMP182 Hassam       00:00-10:00, shift starting at midnight
//   EMP163 Hari Lal     short 3h shift
//   EMP187 M. Yaseen    duplicate name across tenants
//   EMP159 Afsha        re-enrolled under a new device id
//
// The expectations are what the code produced once August reconciled to
// absent 9 / check-out-missing 0 against HR. This is a characterisation test:
// it does not claim every line is CORRECT, it claims the behaviour is KNOWN.
// A diff here is not automatically a failure — it is a change in how a real
// month is read, and it has to be looked at and re-frozen deliberately.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { sessioniseByRoster } from '../../src/lib/attendanceReplay.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
    readFileSync(join(here, '../fixtures/HR-ATT-REGRESSION-01.august-2026.json'), 'utf8'),
);

const sessionsFor = (e) =>
    sessioniseByRoster(
        e.punches.map((p) => ({ punchedAt: new Date(p.at), status: p.status })),
        e.pattern,
    ).map((s) => ({
        day: s.day.toISOString().slice(0, 10),
        punches: s.punches.map((p) => p.timestamp.toISOString().slice(11, 16)),
        corrections: s.corrections.length,
    }));

describe('HR-ATT-REGRESSION-01 August 2026 golden', () => {
    it('covers the whole fixture', () => {
        expect(fixture.employees).toHaveLength(14);
        expect(fixture.employees.reduce((n, e) => n + e.punches.length, 0)).toBe(898);
    });

    it.each(fixture.employees.map((e) => [e.code, e.name, e]))(
        '%s %s reads the same as the reconciled month',
        (_code, _name, e) => {
            expect(sessionsFor(e)).toEqual(e.expectedSessions);
        },
    );

    it('still groups every punch into exactly one session', () => {
        // The invariant underneath the whole month: a scan is never dropped and
        // never counted twice. Both failure modes cost somebody money —
        // dropping loses a worked day, double-counting bills a day off.
        for (const e of fixture.employees) {
            const grouped = sessionsFor(e).reduce((n, s) => n + s.punches.length, 0);
            let kept = 0;
            let prev = null;
            for (const p of [...e.punches].sort((a, b) => new Date(a.at) - new Date(b.at))) {
                const t = new Date(p.at).getTime();
                if (prev !== null && t - prev <= 120_000) continue;
                prev = t;
                kept += 1;
            }
            expect(grouped).toBe(kept);
        }
    });

    it('gives each employee at most one session per day', () => {
        // Attendance is one row per employee-day. Two sessions on one date means
        // the writer either overwrites the first or stores a duplicate — which
        // is exactly how the phantom Tuesday rows appeared, a night shift's
        // closing scan opening a second session on the following morning.
        for (const e of fixture.employees) {
            const days = sessionsFor(e).map((s) => s.day);
            expect(days).toEqual([...new Set(days)]);
        }
    });

    it('is derived in UTC, matching how production reads the device', () => {
        // startOfDay uses local setHours, so the whole month re-buckets under a
        // different TZ: the same punches gave 321 sessions under UTC and 390
        // under UTC+5. Device timestamps carry the local wall clock already, so
        // UTC is the correct reading and the one HR's workbook agrees with.
        expect(new Date().getTimezoneOffset()).toBe(0);
    });
});
