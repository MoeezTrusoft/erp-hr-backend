// B2 (plan 25) / T-2.8 — [A-06 / Decision 5] tenant ruleset template.
// Red = service does not exist / does not enforce its contract.
import { jest, describe, it, expect, beforeAll } from '@jest/globals';

const store = {
  ruleConfigs: {
    'src-uuid': { tenantId: 'src-uuid', midMonthJoinerProration: true, lwpRecovery: true, garnishmentCapPct: 33, deductionBasis: 'GROSS', absenceRecoveryEnabled: true, eobiEnabled: false, status: 'PUBLISHED', version: 3 },
  },
  rules: [
    { tenantId: 'src-uuid', ruleKey: 'LATE', enabled: true, triggerCount: 3, deductionDays: 1, periodScope: 'PAY_PERIOD', counterGroup: null, maxDeductionDaysPerPeriod: null },
    { tenantId: 'src-uuid', ruleKey: 'MISSING_PUNCH', enabled: true, triggerCount: 3, deductionDays: 0.5, periodScope: 'PAY_PERIOD', counterGroup: 'punch', maxDeductionDaysPerPeriod: null },
  ],
  earningTypes: [
    { tenantId: 'src-uuid', code: 'BASE_SALARY', name: 'Basic Salary', description: null, type: 'EARNING', isTaxable: true },
  ],
  deductionTypes: [
    { tenantId: 'src-uuid', code: 'LOAN_REPAYMENT', name: 'Loan Repayment', description: null, type: 'DEDUCTION', rate: null, preTax: false },
  ],
};

const created = { ruleConfig: [], rules: [], earnings: [], deductions: [] };

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    payrollRuleConfig: {
      findUnique: jest.fn(async ({ where }) => store.ruleConfigs[where.tenantId] || null),
      upsert: jest.fn(async ({ where, update, create }) => { created.ruleConfig.push({ where, update, create }); return create; }),
    },
    attendanceDeductionRule: {
      findMany: jest.fn(async () => store.rules),
      upsert: jest.fn(async ({ where, update, create }) => { created.rules.push({ where, update, create }); return create; }),
    },
    payrollPayslip: { count: jest.fn(async ({ where }) => (where.tenantId === 'dirty-uuid' ? 5 : 0)) },
    payrollRun: { count: jest.fn(async () => 0) },
    payrollEarningType: {
      findMany: jest.fn(async () => store.earningTypes),
      createMany: jest.fn(async ({ data }) => { created.earnings.push(...data); return { count: data.length }; }),
    },
    payrollDeductionType: {
      findMany: jest.fn(async () => store.deductionTypes),
      createMany: jest.fn(async ({ data }) => { created.deductions.push(...data); return { count: data.length }; }),
    },
  },
}));

let seedConfigFromTenant;
beforeAll(async () => {
  ({ seedConfigFromTenant } = await import('../../src/services/payrollConfigSeed.service.js'));
});

describe('[A-06] seedConfigFromTenant', () => {
  it('refuses non-admin actors (403)', async () => {
    await expect(seedConfigFromTenant({ actorTenantId: 'src-uuid', actorIsAdmin: false, sourceTenantId: 'src-uuid', targetTenantId: 'tgt-uuid' }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('refuses a target with payslip-bearing history (409)', async () => {
    await expect(seedConfigFromTenant({ actorTenantId: 'src-uuid', actorIsAdmin: true, sourceTenantId: 'src-uuid', targetTenantId: 'dirty-uuid' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('refuses seeding a tenant from itself (409)', async () => {
    await expect(seedConfigFromTenant({ actorTenantId: 'src-uuid', actorIsAdmin: true, sourceTenantId: 'src-uuid', targetTenantId: 'src-uuid' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('copies config as DRAFT v1, rules, and both type catalogs', async () => {
    const summary = await seedConfigFromTenant({ actorTenantId: 'src-uuid', actorIsAdmin: true, sourceTenantId: 'src-uuid', targetTenantId: 'tgt-uuid' });
    expect(summary.ruleConfig).toBe(true);
    expect(summary.deductionRules).toBe(2);
    expect(summary.earningTypes).toBe(1);
    expect(summary.deductionTypes).toBe(1);
    // seeded config is DRAFT — publish stays the gate
    expect(created.ruleConfig[0].create.status).toBe('DRAFT');
    expect(created.ruleConfig[0].create.absenceRecoveryEnabled).toBe(true);
    // rules keyed per tenant+ruleKey
    expect(created.rules.every((r) => r.create.tenantId === 'tgt-uuid')).toBe(true);
    // types landed under the target tenant
    expect(created.earnings.every((t) => t.tenantId === 'tgt-uuid')).toBe(true);
    expect(created.deductions.every((t) => t.tenantId === 'tgt-uuid')).toBe(true);
  });
});
