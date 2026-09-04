// HR-PAYROLL-EMPLOYMENT-PERIOD-01 — pay for the days someone was employed.
//
// M. Meesam left on 2026-08-20 and was re-hired from 2026-09-07. Neither half
// of that could be represented, and the August payroll was wrong either way:
//
//   payrollService:376 prorated using `employee.term_date || employee.terminationDate`.
//   Employee has NEITHER column — it carries hire_date, joining_date,
//   probation_end_date, employement_status and status, and no leaving date at
//   all. So the fourth argument was permanently undefined, effectiveEnd always
//   fell back to periodEnd, and the leaver branch of computeProrationFactor had
//   never once executed. Mid-month JOINERS prorated correctly, which is why it
//   looked like it worked.
//
//   The only leaver control was `status: 'active'` on the run's employee query,
//   and that is a cliff: leave him active and he is paid a FULL August for 19
//   days worked; deactivate him and he is dropped from the run entirely and
//   loses the 19 days he did work. There was no way to say "paid to the 19th".
//
// A re-hire also cannot live in a single hire_date. Overwriting it with the new
// start date would make September prorate correctly and destroy the tenure that
// leave accrual, gratuity and probation are measured from.
//
// So employment becomes a list of periods, and proration is the share of the
// run that the periods cover. Two rows express the re-hire, and hire_date goes
// back to meaning what it says.
//
// Deliberately NOT reusing EmploymentTerms, which is already effective-dated and
// already period-filtered by the payroll query: `effectiveFrom` there is a
// COMPENSATION version boundary. A raise on 15 September opens a terms row on
// the 15th, and prorating from that window would pay a raised employee 16/30 of
// a month and nothing for the first half — turning every mid-month salary
// revision into a half-paid month. The two look identical in the schema and are
// not the same thing.
import { describe, it, expect } from '@jest/globals';
import { computeProrationFactor } from '../../src/services/payrollService.js';

const AUG = ['2026-08-01', '2026-08-31'];
const SEP = ['2026-09-01', '2026-09-30'];
const pct = (factor) => Number((Number(factor) / 10_000).toFixed(2)); // 1e6 scale -> %

describe('HR-PAYROLL-EMPLOYMENT-PERIOD-01 proration from employment periods', () => {
    it('pays a full month for someone employed throughout', () => {
        const f = computeProrationFactor(...AUG, [{ startDate: '2020-01-01', endDate: null }]);
        expect(f).toBe(1_000_000n);
    });

    it('pays M. Meesam 19/31 of August — he left on the 20th', () => {
        // The day of leaving is not worked. 1..19 inclusive = 19 days.
        const f = computeProrationFactor(...AUG, [
            { startDate: '2024-05-01', endDate: '2026-08-19' },
        ]);
        expect(pct(f)).toBe(Number(((19 / 31) * 100).toFixed(2)));
    });

    it('pays M. Meesam 24/30 of September — he re-joined on the 7th', () => {
        const f = computeProrationFactor(...SEP, [
            { startDate: '2024-05-01', endDate: '2026-08-19' },
            { startDate: '2026-09-07', endDate: null },
        ]);
        expect(pct(f)).toBe(Number(((24 / 30) * 100).toFixed(2)));
    });

    it('pays nothing for the month he was not employed at all', () => {
        // 20 Aug - 6 Sep. An August-only leaver must not appear in a September
        // run with a full month's salary just because a terms row still exists.
        const f = computeProrationFactor('2026-08-20', '2026-08-31', [
            { startDate: '2024-05-01', endDate: '2026-08-19' },
        ]);
        expect(f).toBe(0n);
    });

    it('sums two periods that both fall inside one run', () => {
        // Left on the 10th, back on the 21st: 10 + 11 = 21 of 31 days.
        const f = computeProrationFactor(...AUG, [
            { startDate: '2024-01-01', endDate: '2026-08-10' },
            { startDate: '2026-08-21', endDate: null },
        ]);
        expect(pct(f)).toBe(Number(((21 / 31) * 100).toFixed(2)));
    });

    it('never double-counts a day when two periods overlap', () => {
        // Bad data must not pay someone 200% of a month.
        const f = computeProrationFactor(...AUG, [
            { startDate: '2026-08-01', endDate: '2026-08-31' },
            { startDate: '2026-08-01', endDate: '2026-08-31' },
        ]);
        expect(f).toBe(1_000_000n);
    });

    it('falls back to a full month when no period is on file', () => {
        // Backfill has to be safe: an employee with no rows yet must keep being
        // paid normally, not silently drop to zero.
        expect(computeProrationFactor(...AUG, [])).toBe(1_000_000n);
        expect(computeProrationFactor(...AUG, null)).toBe(1_000_000n);
    });

    it('clips a period that starts before and ends after the run', () => {
        const f = computeProrationFactor(...AUG, [
            { startDate: '2026-07-15', endDate: '2026-09-15' },
        ]);
        expect(f).toBe(1_000_000n);
    });

    it('ignores a period that ends before it starts', () => {
        // Produced for real: a re-run of the apply script closed the RE-OPEN
        // period at the termination date, leaving 2026-09-07 -> 2026-08-19 on
        // M. Meesam. Such a row must contribute nothing rather than a negative
        // day count — his September silently paid 0% instead of 80%.
        const f = computeProrationFactor('2026-09-01', '2026-09-30', [
            { startDate: '2026-09-07', endDate: '2026-08-19' },
        ]);
        expect(f).toBe(0n);
    });

    it('pays the valid spell even when an inverted one sits beside it', () => {
        const f = computeProrationFactor('2026-09-01', '2026-09-30', [
            { startDate: '2026-09-07', endDate: null },
            { startDate: '2026-09-07', endDate: '2026-08-19' }, // junk
        ]);
        expect(pct(f)).toBe(Number(((24 / 30) * 100).toFixed(2)));
    });

    it('pays zero for a spell that ended before the run began', () => {
        // The August dry-run caught this: affan/afzal/shizza left on 2026-07-31
        // and were each paid a FULL August. Their period was fetched with
        // `endDate >= periodStart`, which filters a fully-past spell OUT, and an
        // empty list means "no history on file" — which pays in full. The fetch
        // must keep past spells so this function can score them as zero.
        const f = computeProrationFactor(...AUG, [
            { startDate: '2024-01-01', endDate: '2026-07-31' },
        ]);
        expect(f).toBe(0n);
    });

    it('still honours a legacy hire_date passed as a bare date', () => {
        // The old two-date call shape stays supported so callers that have not
        // been migrated keep their mid-month joiner proration.
        const f = computeProrationFactor(...AUG, '2026-08-17', null);
        expect(pct(f)).toBe(Number(((15 / 31) * 100).toFixed(2)));
    });
});
