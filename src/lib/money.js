// F-12 / ARCH-01 §2.3, §5.1 / ARCH-06 C-06, C-11.
// Money is BigInt minor units in the engine, an exact decimal string at Prisma,
// and a decimal/minor-unit string on JSON boundaries. Number is never used for
// monetary conversion or arithmetic.

export const CURRENCY_EXPONENT = Object.freeze({
  USD: 2,
  EUR: 2,
  GBP: 2,
  PKR: 2,
  AED: 2,
  SAR: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
});

export const MINOR_PER_MAJOR = 100n;
const DECIMAL_SCALE = 4;
const TEN = 10n;

const pow10 = (exponent) => TEN ** BigInt(exponent);

const assertMinor = (value, label = 'minor units') => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`HR-2002 money: ${label} must be exact integer minor units`);
};

const exponentOf = (currency) => {
  const code = String(currency || '').toUpperCase();
  const exponent = CURRENCY_EXPONENT[code];
  if (exponent === undefined) throw new Error(`HR-2008 money: unsupported currency ${currency}`);
  return exponent;
};

const decimalParts = (value) => {
  if (value === null || value === undefined || value === '') {
    throw new Error('HR-2001 money: decimal value is required');
  }
  const raw = typeof value === 'object' && typeof value.toString === 'function'
    ? value.toString()
    : String(value);
  const match = raw.trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new Error(`HR-2001 money: invalid decimal value ${raw}`);

  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] || '';
  const scientific = match[4] ? parseInt(match[4], 10) : 0;
  let coefficient = BigInt(`${match[2]}${fraction}` || '0') * sign;
  let scale = fraction.length - scientific;
  if (scale < 0) {
    coefficient *= pow10(-scale);
    scale = 0;
  }
  return { coefficient, scale };
};

const divideHalfEven = (numerator, denominator) => {
  if (denominator === 0n) throw new Error('HR-2006 money: denominator cannot be zero');
  let q = numerator / denominator;
  const r = numerator % denominator;
  const twice = 2n * (r < 0n ? -r : r);
  const divisor = denominator < 0n ? -denominator : denominator;
  const away = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  if (twice > divisor || (twice === divisor && (q < 0n ? -q : q) % 2n === 1n)) q += away;
  return q;
};

const rescale = (coefficient, fromScale, toScale) => {
  if (fromScale === toScale) return coefficient;
  if (fromScale < toScale) return coefficient * pow10(toScale - fromScale);
  return divideHalfEven(coefficient, pow10(fromScale - toScale));
};

const fixedDecimal = (coefficient, scale) => {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(-scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
};

export const decimalToMinor = (value, currency = 'USD') => {
  const { coefficient, scale } = decimalParts(value);
  return rescale(coefficient, scale, exponentOf(currency));
};

export const decimalToPersistence = (value) => {
  const { coefficient, scale } = decimalParts(value);
  const persisted = rescale(coefficient, scale, DECIMAL_SCALE);
  const integerDigits = (persisted < 0n ? -persisted : persisted).toString().length - DECIMAL_SCALE;
  if (integerDigits > 14) throw new Error(`HR-2009 money: ${value} exceeds Decimal(18,4)`);
  return fixedDecimal(persisted, DECIMAL_SCALE);
};

export const minorToDecimal = (minor, currency = 'USD') => {
  const exponent = exponentOf(currency);
  if (exponent > DECIMAL_SCALE) throw new Error(`HR-2009 money: ${currency} exceeds Decimal(18,4) scale`);
  return fixedDecimal(assertMinor(minor) * pow10(DECIMAL_SCALE - exponent), DECIMAL_SCALE);
};

export const minorToWire = (minor) => assertMinor(minor).toString();

export const minorToWireDecimal = (minor, currency = 'USD') =>
  fixedDecimal(assertMinor(minor), exponentOf(currency));

// Compatibility names now retain exact strings/BigInts rather than Numbers.
export const fromMajor = decimalToMinor;
export const toMajor = minorToDecimal;

export const add = (a, b) => assertMinor(a, 'add a') + assertMinor(b, 'add b');
export const sub = (a, b) => assertMinor(a, 'sub a') - assertMinor(b, 'sub b');
export const sum = (values) => values.reduce((total, value) => total + assertMinor(value, 'sum element'), 0n);

export const mulRate = (minor, rate) => {
  const amount = assertMinor(minor, 'mulRate amount');
  const { coefficient, scale } = decimalParts(rate);
  return divideHalfEven(amount * coefficient, pow10(scale));
};

export const scaleRational = (minor, numerator, denominator) =>
  divideHalfEven(
    assertMinor(minor, 'scaleRational amount') * assertMinor(numerator, 'scaleRational numerator'),
    assertMinor(denominator, 'scaleRational denominator'),
  );

export const allocateEvenly = (minor, parts) => {
  const amount = assertMinor(minor, 'allocateEvenly amount');
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new Error(`HR-2005 money: allocate parts must be a positive integer (got ${parts})`);
  }
  const count = BigInt(parts);
  const sign = amount < 0n ? -1n : 1n;
  const absolute = amount < 0n ? -amount : amount;
  const base = absolute / count;
  const remainder = absolute % count;
  return Array.from({ length: parts }, (_, index) =>
    sign * (base + (BigInt(index) < remainder ? 1n : 0n)));
};

export const compareDecimal = (left, right) => {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const av = rescale(a.coefficient, a.scale, scale);
  const bv = rescale(b.coefficient, b.scale, scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
};

const isPrismaDecimal = (value) =>
  value !== null && typeof value === 'object' &&
  (value.constructor?.name === 'Decimal' || value.constructor?.name === 'DecimalLight') &&
  typeof value.toFixed === 'function';

export const serializePayrollMoney = (value) => {
  if (isPrismaDecimal(value)) return value.toFixed(DECIMAL_SCALE);
  if (Array.isArray(value)) return value.map(serializePayrollMoney);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializePayrollMoney(item)]));
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
};

export default {
  CURRENCY_EXPONENT,
  MINOR_PER_MAJOR,
  decimalToMinor,
  decimalToPersistence,
  minorToDecimal,
  minorToWire,
  minorToWireDecimal,
  fromMajor,
  toMajor,
  add,
  sub,
  sum,
  mulRate,
  scaleRational,
  allocateEvenly,
  compareDecimal,
  serializePayrollMoney,
};
