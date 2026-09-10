// B1 (plan 25) / T-2.5 — [CHECK23] ACTIVE tax-slab overlap guard.
//
// Live prod state (verified 2026-09-10): 40 ACTIVE PK rows over only 16 distinct
// brackets — three ACTIVE rows share bracketMin=0. Harmless at 0% today, but the
// day someone edits one copy the engine's slab resolution becomes ambiguous.
//
// Contract: within a tenant+country, a NEW/EDITED ACTIVE slab must not overlap
// any already-ACTIVE slab's bracket range (shared endpoints coexist; open-ended
// top slabs count to +inf). INACTIVE writes and other countries are unaffected.
// Red = no guard exists, every create/update below succeeds silently.
import { jest, describe, it, expect, beforeAll } from '@jest/globals';

const existing = [
  { id: 1, countryCode: 'PK', status: 'ACTIVE', bracketMin: '0', bracketMax: '600000', baseTax: '0', rate: 0, effectiveFrom: new Date('2026-07-01') },
  { id: 2, countryCode: 'PK', status: 'ACTIVE', bracketMin: '600000', bracketMax: '1200000', baseTax: '0', rate: 0.05, effectiveFrom: new Date('2026-07-01') },
  { id: 3, countryCode: 'PK', status: 'ACTIVE', bracketMin: '1200000', bracketMax: '2000000', baseTax: '30000', rate: 0.15, effectiveFrom: new Date('2026-07-01') },
  { id: 8, countryCode: 'US', status: 'ACTIVE', bracketMin: '0', bracketMax: '50000', baseTax: '0', rate: 0.1, effectiveFrom: new Date('2026-01-01') },
];

const created = [];
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    taxRate: {
      create: jest.fn(async ({ data }) => { created.push(data); return { id: 99, ...data }; }),
      findFirst: jest.fn(async ({ where }) => { const c = (where?.AND || []).find((x) => x.id !== undefined); return existing.find((r) => r.id === c?.id) || null; }),
      findMany: jest.fn(async ({ where }) => {
        const and = where?.AND || [];
        const cc = and.find((x) => x.countryCode !== undefined)?.countryCode;
        const st = and.find((x) => x.status !== undefined)?.status;
        return existing.filter((r) => (cc ? r.countryCode === cc : true) && (st ? r.status === st : true));
      }),
      updateMany: jest.fn(async ({ data }) => ({ count: 1, data })),
      count: jest.fn(async () => existing.length),
    },
  },
}));

jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
  scopedWhere: (tenantId, where = {}) => ({ AND: [{ tenantId }, where] }),
  scopedData: (tenantId, data) => ({ ...data, tenantId }),
}));

let createTaxSlab, updateTaxSlab;
beforeAll(async () => {
  ({ createTaxSlab, updateTaxSlab } = await import('../../src/services/payrollTaxSlab.service.js'));
});

const base = { tenantId: '11111111-1111-1111-1111-111111111111', countryCode: 'PK', effectiveFrom: '2026-09-01', rate: 0.1 };

describe('[CHECK23] ACTIVE slab overlap guard — create', () => {
  it('rejects a new ACTIVE slab inside an existing bracket (409)', async () => {
    await expect(createTaxSlab({ ...base, bracketMin: 300000, bracketMax: 900000 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('rejects an exact duplicate of an existing bracket (409)', async () => {
    await expect(createTaxSlab({ ...base, bracketMin: 0, bracketMax: 600000, rate: 0 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('rejects a slab whose open-ended top swallows existing brackets (409)', async () => {
    await expect(createTaxSlab({ ...base, bracketMin: 0, bracketMax: null, rate: 0.2 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('allows narrowing an ACTIVE slab to share only an endpoint (update)', async () => {
    await expect(updateTaxSlab({ ...base, id: 3, bracketMin: 1200000, bracketMax: 1500000 }))
      .resolves.toBeTruthy();
  });

  it('ignores INACTIVE writes (retirement flow stays open)', async () => {
    await expect(createTaxSlab({ ...base, bracketMin: 0, bracketMax: 600000, status: 'INACTIVE' }))
      .resolves.toBeTruthy();
  });

  it('ignores other countries', async () => {
    await expect(createTaxSlab({ ...base, countryCode: 'US', bracketMin: 50000, bracketMax: 100000, rate: 0.02 }))
      .resolves.toBeTruthy();
  });
});

describe('[CHECK23] ACTIVE slab overlap guard — update', () => {
  it('rejects moving an ACTIVE slab into an existing bracket (409)', async () => {
    await expect(updateTaxSlab({ ...base, id: 2, bracketMin: 100000, bracketMax: 500000 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('allows deactivating a slab regardless of bracket state', async () => {
    await expect(updateTaxSlab({ ...base, id: 2, status: 'INACTIVE' }))
      .resolves.toBeTruthy();
  });
});
