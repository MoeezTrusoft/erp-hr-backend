// F-12 / ARCH-01 §2.3, §5.1 / ARCH-06 C-06, C-11.
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
  CURRENCY_EXPONENT,
  add,
  allocateEvenly,
  decimalToMinor,
  minorToDecimal,
  minorToWire,
  mulRate,
  serializePayrollMoney,
  sub,
  sum,
} from '../../src/lib/money.js';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../../prisma/migrations/20260726180000_f12_exact_payroll_money/migration.sql', import.meta.url),
  'utf8',
);

describe('F-12 exact payroll money persistence', () => {
  it('converts decimal text without Number arithmetic and preserves 0.1 exactly', () => {
    expect(decimalToMinor('0.1', 'USD')).toBe(10n);
    expect(minorToDecimal(10n, 'USD')).toBe('0.1000');
    expect(minorToWire(10n)).toBe('10');
  });

  it('supports values beyond the JS safe integer and negative adjustments', () => {
    const large = decimalToMinor('9007199254740.991', 'KWD');
    expect(large).toBe(9007199254740991n);
    expect(minorToDecimal(large, 'KWD')).toBe('9007199254740.9910');
    expect(add(large, -1n)).toBe(9007199254740990n);
    expect(sub(-125n, 25n)).toBe(-150n);
  });

  it('governs ISO currency exponents, including 0 and 3 decimal currencies', () => {
    expect(CURRENCY_EXPONENT.USD).toBe(2);
    expect(CURRENCY_EXPONENT.JPY).toBe(0);
    expect(CURRENCY_EXPONENT.KWD).toBe(3);
    expect(decimalToMinor('1.234', 'KWD')).toBe(1234n);
    expect(decimalToMinor('1.5', 'JPY')).toBe(2n);
  });

  it('uses half-even at the only scaling and decimal-to-minor rounding sites', () => {
    expect(decimalToMinor('0.005', 'USD')).toBe(0n);
    expect(decimalToMinor('0.015', 'USD')).toBe(2n);
    expect(decimalToMinor('-0.015', 'USD')).toBe(-2n);
    expect(mulRate(5n, '0.5')).toBe(2n);
    expect(mulRate(7n, '0.5')).toBe(4n);
  });

  it('keeps allocation and totals equal for positive and negative money', () => {
    const positive = allocateEvenly(100n, 3);
    const negative = allocateEvenly(-100n, 3);
    expect(positive).toEqual([34n, 33n, 33n]);
    expect(negative).toEqual([-34n, -33n, -33n]);
    expect(sum(positive)).toBe(100n);
    expect(sum(negative)).toBe(-100n);
  });

  it('serializes mocked Prisma Decimal values to deterministic strings, never objects', () => {
    const decimal = (text) => ({
      constructor: { name: 'Decimal' },
      toFixed: (places) => `${text}${text.includes('.') ? '' : '.'}${'0'.repeat(places)}`.slice(0, text.includes('.') ? text.indexOf('.') + places + 1 : undefined),
      toString: () => text,
    });
    const result = serializePayrollMoney({
      currencyCode: 'KWD',
      totalGross: decimal('0.1'),
      payslips: [{ grossAmount: decimal('9007199254740.991'), deductions: [{ amount: decimal('-1.234') }] }],
      employee: { rating: 4.5 },
    });

    expect(result).toEqual({
      currencyCode: 'KWD',
      totalGross: '0.1000',
      payslips: [{ grossAmount: '9007199254740.9910', deductions: [{ amount: '-1.2340' }] }],
      employee: { rating: 4.5 },
    });
    expect(JSON.stringify(result)).toContain('"totalGross":"0.1000"');
  });

  it('maps only governed payroll money columns to Decimal(18,4)', () => {
    const decimalFields = [
      'totalGross', 'totalDeductions', 'totalNet',
      'grossAmount', 'netAmount',
      'amount', 'bracketMin', 'bracketMax', 'baseTax', 'thresholdAmount',
    ];
    for (const field of decimalFields) {
      expect(schema).toMatch(new RegExp(`\\b${field}\\s+Decimal\\??\\s+(?:@default\\(0\\)\\s+)?@db\\.Decimal\\(18, 4\\)`));
    }
    expect(schema).toMatch(/fte\s+Float\?/);
    expect(schema).toMatch(/overall_rating\s+Float\?/);
    expect(schema).toMatch(/total_hours\s+Float/);
  });

  it('stages a guarded value-preserving conversion without destructive DDL', () => {
    expect(migration.indexOf('F-12 migration blocked')).toBeLessThan(migration.indexOf('ALTER TABLE'));
    expect(migration).toMatch(/USING ROUND\("totalGross"::numeric, 4\)/);
    expect(migration).not.toMatch(/\bDROP\s+(?:COLUMN|TABLE)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
  });
});
