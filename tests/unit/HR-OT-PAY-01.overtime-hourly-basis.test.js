// HR-OT-PAY-01 — overtime is priced from the hours the person's roster works,
// not a fixed 176-hour month. 45,000 a month on a 45-hour week works
// 45 × 52 / 12 = 195 hours, so an hour is worth 230.77, not 255.68.
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const AUGUST = {
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T00:00:00.000Z'),
    countryCode: 'PK',
    currencyCode: 'PKR',
};
const overtimePay = (line) => {
    const slip = buildPayslipFromInputs({
        employee: { id: 1 },
        employmentTerm: { baseSalary: 45000, payFrequency: 'MONTHLY', currency: 'PKR' },
        payrollRun: AUGUST,
        taxRateRows: [],
        asOf: AUGUST.periodEnd,
        bridges: { overtimeLines: [{ hours: 2, rate: 1.5, date: '2026-08-10', ...line }] },
    });
    const ot = (slip.earnings || slip.earningLines || []).find((e) => /Overtime/.test(e.description || ''));
    return Number(ot.amount);
};

describe('overtime hourly basis', () => {
    it('uses the roster\'s weekly hours', () => {
        // 45,000 / (45 × 52 / 12) = 230.77 an hour → 2 h × 1.5 = 692.31
        expect(overtimePay({ weeklyHours: 45 })).toBe(692); // lines are whole rupees
    });
    it('falls back to 176 hours a month when the day has no roster', () => {
        // 45,000 / 176 = 255.68 per hour → 2 h × 1.5 = 767.05
        expect(overtimePay({})).toBe(767);
    });
    it('pays the sealed rate (e.g. a rule\'s 2x)', () => {
        expect(overtimePay({ weeklyHours: 45, rate: 2 })).toBe(923);
    });
});
