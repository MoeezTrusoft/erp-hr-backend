// N-18 — selectEffectiveTaxRates must honor TaxRate.status (RowStatus).
// Four tenants carried INACTIVE legacy slabs (annual bounds) alongside ACTIVE
// monthly-normalized FBR slabs; the selector ignored status, so both sets were
// selected, overlapping brackets each taxed their slice, and computed tax came
// out ≈ 0. The overlap guard (CHECK23) only protects ACTIVE rows — which is
// exactly why INACTIVE rows must never reach the computation.
import { describe, it, expect } from '@jest/globals';
import { selectEffectiveTaxRates } from '../../src/services/payrollService.js';

const AT = new Date('2026-08-31T00:00:00.000Z');

const slab = (overrides = {}) => ({
    countryCode: 'PK',
    bracketMin: 0,
    bracketMax: null,
    rate: 0.05,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    status: 'ACTIVE',
    ...overrides,
});

describe('N-18 tax selection filters on ACTIVE status', () => {
    it('selects ACTIVE rows inside the window', () => {
        const rows = [slab({ bracketMin: 0 }), slab({ bracketMin: 100000, rate: 0.1 })];
        const selected = selectEffectiveTaxRates(rows, { countryCode: 'PK', asOf: AT });
        expect(selected).toHaveLength(2);
        expect(selected.map((r) => r.bracketMin)).toEqual([0, 100000]);
    });

    it('never selects a DEACTIVATED row, even inside the window', () => {
        const rows = [
            slab({ bracketMin: 0 }),
            slab({ bracketMin: 100000, rate: 0.1, status: 'DEACTIVATED' }),
            slab({ bracketMin: 100000, rate: 0.15, status: 'ACTIVE' }),
        ];
        const selected = selectEffectiveTaxRates(rows, { countryCode: 'PK', asOf: AT });
        expect(selected).toHaveLength(2);
        expect(selected.find((r) => r.rate === 0.1)).toBeUndefined();
    });

    it('excludes INACTIVE legacy annual slabs overlapping ACTIVE monthly slabs', () => {
        const rows = [
            // legacy annual-bound slab, INACTIVE but "effective" by date
            slab({ bracketMin: 0, bracketMax: 600000, rate: 0, status: 'INACTIVE' }),
            // active monthly-normalized slabs
            slab({ bracketMin: 0, bracketMax: null, rate: 0.02 }),
        ];
        const selected = selectEffectiveTaxRates(rows, { countryCode: 'PK', asOf: AT });
        expect(selected).toHaveLength(1);
        expect(selected[0].rate.toString()).toBe('0.02');
    });

    it('rows without a status field still count (test fixtures / older shapes)', () => {
        const rows = [{ countryCode: 'PK', bracketMin: 0, bracketMax: null, rate: 0.05, effectiveFrom: '2026-01-01', effectiveTo: null }];
        const selected = selectEffectiveTaxRates(rows, { countryCode: 'PK', asOf: AT });
        expect(selected).toHaveLength(1);
    });

    it('still excludes foreign-country and future rows', () => {
        const rows = [
            slab({ countryCode: 'AE' }),
            slab({ effectiveFrom: new Date('2027-01-01T00:00:00.000Z') }),
            slab(),
        ];
        const selected = selectEffectiveTaxRates(rows, { countryCode: 'PK', asOf: AT });
        expect(selected).toHaveLength(1);
    });
});
