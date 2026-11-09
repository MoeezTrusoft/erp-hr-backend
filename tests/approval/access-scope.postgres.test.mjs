// X3 against Postgres (forced RLS): direct reports are tenant-scoped, one level, never self-managed.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, other, people, db } from "./fixtures.mjs";
import { mcpCtx } from "../../src/mcp/context.js";
import { tenantTransaction } from "../../src/lib/rlsTenant.js";
import prisma from "../../src/lib/prisma.js";
import { SCOPE, scopedEmployeeIds, hasDirectReports } from "../../src/lib/accessScope.js";

test("team scope: direct reports only, tenant isolated, edge cases", { timeout: 120000 }, async () => {
  await setup();
  const mgr = people.MANAGER.id;
  const emp = people.EMPLOYEE.id; // managed by MANAGER in the fixture
  const inTenant = (tenantId, fn) =>
    mcpCtx.run({ user: { tenantId } }, () => tenantTransaction(prisma, fn, { tenantId, txOptions: { timeout: 60000 } }));
  const ids = (scope, acting, tenantId = company) =>
    inTenant(tenantId, (tx) => scopedEmployeeIds(tx, { tenantId, scope, actingEmployeeId: acting }));
  const reports = (employeeId, tenantId = company) => inTenant(tenantId, (tx) => hasDirectReports(tx, { tenantId, employeeId }));

  assert.deepEqual((await ids(SCOPE.TEAM, mgr)).sort(), [mgr, emp].sort(), "manager sees self + direct report");
  assert.deepEqual(await ids(SCOPE.SELF, emp), [emp], "employee sees only self");
  assert.equal(await ids(SCOPE.ALL, mgr), null, "ALL means no limit");
  assert.deepEqual(await ids(SCOPE.NONE, mgr), [], "NONE sees nobody");
  assert.deepEqual(await ids(SCOPE.TEAM, null), [], "no identity sees nobody");
  assert.deepEqual(await ids(SCOPE.TEAM, emp), [emp], "a non-manager in TEAM mode sees only self");

  assert.equal(await reports(mgr, company), true);
  assert.equal(await reports(emp, company), false);
  assert.equal(await reports(0, company), false);

  // An employee who is their own manager must not count as their own report.
  await db((tx) => tx.employee.update({ where: { id: emp }, data: { managerId: emp } }));
  assert.equal(await reports(emp, company), false);
  assert.deepEqual(await ids(SCOPE.TEAM, emp), [emp]);
  assert.deepEqual(await ids(SCOPE.TEAM, mgr), [mgr], "after the report moved away the manager sees only self");
  await db((tx) => tx.employee.update({ where: { id: emp }, data: { managerId: mgr } }));

  // Cross-tenant: the other tenant cannot see this tenant's reports, even asking by id.
  assert.deepEqual(await ids(SCOPE.TEAM, mgr, other), [mgr], "RLS hides the report from another tenant");
  assert.equal(await reports(mgr, other), false);
});
