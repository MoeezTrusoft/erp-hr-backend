import { describe, it, expect } from '@jest/globals';
import { cleanSlabSet } from '../../src/services/taxSlabChangeRequest.service.js';

describe('cleanSlabSet', () => {
  it('chains each slab from the previous limit and works out the base tax', () => {
    const set = cleanSlabSet([{ upto: 50000, ratePct: 0 }, { upto: 100000, ratePct: 1 }, { upto: 200000, ratePct: 11 }, { ratePct: 20 }]);
    expect(set.map((s) => [s.bracketMin, s.bracketMax, s.rate, s.baseTax])).toEqual([
      ['0.0000', '50000.0000', 0, '0.0000'],
      ['50000.0000', '100000.0000', 0.01, '0.0000'],
      ['100000.0000', '200000.0000', 0.11, '500.0000'],
      ['200000.0000', null, 0.2, '11500.0000'],
    ]);
  });
  it('accepts one open-ended slab, and a rate with decimals', () => {
    expect(cleanSlabSet([{ ratePct: 12.5 }])).toEqual([{ bracketMin: '0.0000', bracketMax: null, rate: 0.125, ratePct: 12.5, baseTax: '0.0000' }]);
    expect(cleanSlabSet([{ upto: 1, ratePct: 0.0001 }, { ratePct: 100 }])[0].rate).toBe(0.000001);
  });
  it.each([
    ['nothing', [], /at least one/],
    ['not a list', null, /at least one/],
    ['too many', Array.from({ length: 13 }, (_, i) => ({ upto: i + 1, ratePct: 1 })), /up to 12/],
    ['limits that do not rise', [{ upto: 10, ratePct: 1 }, { upto: 10, ratePct: 2 }, { ratePct: 3 }], /must be above 10/],
    ['a limit of zero', [{ upto: 0, ratePct: 1 }, { ratePct: 3 }], /above 0/],
    ['a limit that is not a number', [{ upto: 'x', ratePct: 1 }, { ratePct: 3 }], /above 0/],
    ['a huge limit', [{ upto: 1e13, ratePct: 1 }, { ratePct: 3 }], /too large/],
    ['an open slab in the middle', [{ ratePct: 1 }, { ratePct: 3 }], /needs an upper limit/],
    ['a closed last slab', [{ upto: 10, ratePct: 1 }], /last slab has no upper limit/],
    ['a negative rate', [{ upto: 10, ratePct: -1 }, { ratePct: 3 }], /between 0 and 100/],
    ['a rate above 100', [{ upto: 10, ratePct: 100.5 }, { ratePct: 3 }], /between 0 and 100/],
    ['no rate', [{ upto: 10 }, { ratePct: 3 }], /between 0 and 100/],
  ])('refuses %s', (_name, input, message) => {
    expect(() => cleanSlabSet(input)).toThrow(message);
  });
});
