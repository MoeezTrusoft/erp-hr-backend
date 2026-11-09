// T-2.8 against Postgres: a company admin may copy only ITS OWN payroll ruleset out, never read another
// company's, and the copy is a DRAFT in an empty target.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, company, other, db } from "../approval/fixtures.mjs";
import { mcpCtx } from "../../src/mcp/context.js";
import { seedConfigFromTenant } from "../../src/services/payrollConfigSeed.service.js";
import { tenantTransaction } from "../../src/lib/rlsTenant.js";
import prisma from "../../src/lib/prisma.js";

const asTenant = (tenantId, fn) => mcpCtx.run({ user: { tenantId, isAdmin: true } }, fn);
const seed = (actor, source, target, extra = {}) =>
  asTenant(actor, () => seedConfigFromTenant({ actorTenantId: actor, actorIsAdmin: true, sourceTenantId: source, targetTenantId: target, ...extra }));
const configOf = (tenantId) =>
  mcpCtx.run({ user: { tenantId } }, () => tenantTransaction(prisma, (tx) => tx.payrollRuleConfig.findFirst({ where: { tenantId } }), { tenantId }));

test("seeding is push-only: own ruleset out, never another company's in", { timeout: 120000 }, async () => {
  await setup();
  await db((tx) => tx.payrollRuleConfig.create({ data: { tenantId: company, lwpRecovery: true, deductionBasis: "BASE", status: "PUBLISHED", version: 4 } }));
  const fresh = randomUUID(); // a not-yet-onboarded company: no payroll history

  // Another company's admin names `company` as the source: refused, nothing written to the target.
  await assert.rejects(() => seed(other, company, fresh), (e) => e.status === 403);
  assert.equal(await mcpCtx.run({ user: { tenantId: fresh } }, () => tenantTransaction(prisma, (tx) => tx.payrollRuleConfig.count({ where: { tenantId: fresh } }), { tenantId: fresh })), 0);

  // A non-admin is refused.
  await assert.rejects(() => asTenant(company, () => seedConfigFromTenant({ actorTenantId: company, actorIsAdmin: false, sourceTenantId: company, targetTenantId: fresh })), (e) => e.status === 403);

  // The owner of the ruleset can copy it out: DRAFT, version 1, only the listed columns.
  const done = await seed(company, company, fresh);
  assert.equal(done.ruleConfig, true);
  const copied = await configOf(fresh);
  assert.equal(copied.status, "DRAFT");
  assert.equal(copied.version, 1);
  assert.equal(copied.lwpRecovery, true);

  // The regression: seeding used to rewrite the CALLER's own row (PUBLISHED v4 became DRAFT v1) and write nothing to the target.
  const source = await configOf(company);
  assert.equal(source.status, "PUBLISHED");
  assert.equal(source.version, 4);

  // The seed is audited on the target company, and seeding again re-copies (idempotent) without touching the source.
  const audit = await mcpCtx.run({ user: { tenantId: fresh } }, () =>
    tenantTransaction(prisma, (tx) => tx.payrollAuditLog.findMany({ where: { tenantId: fresh, action: "PAYROLL_CONFIG_SEEDED" } }), { tenantId: fresh }),
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].newValues.sourceTenantId, company);
  await seed(company, company, fresh);
  assert.equal((await configOf(company)).version, 4);

  // A target with payroll history is refused (409), and copying onto itself is refused.
  await db((tx) => tx.payrollRun.create({ data: { tenantId: company, periodStart: new Date("2031-01-01"), periodEnd: new Date("2031-01-31"), countryCode: "PK", currencyCode: "PKR", status: "PENDING" } }));
  await assert.rejects(() => seed(other, other, company), (e) => e.status === 409);
  await assert.rejects(() => seed(company, company, company), (e) => e.status === 409);
});
