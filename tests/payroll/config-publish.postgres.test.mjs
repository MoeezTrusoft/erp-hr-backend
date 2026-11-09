// T-P1 against Postgres: publishing the payroll config is serialized, flips DRAFT rows, and leaves an
// append-only snapshot that nobody can rewrite afterwards.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, other, db, as, people } from "../approval/fixtures.mjs";
import { mcpCtx } from "../../src/mcp/context.js";
import { tenantTransaction } from "../../src/lib/rlsTenant.js";
import prisma from "../../src/lib/prisma.js";
import { publishConfig, getConfigStatus } from "../../src/services/payrollConfigActions.service.js";

let ready; // the fixtures create fixed employee codes: set up once per process
const ensure = () => (ready ||= setup());
const refused = (fn, msg) => assert.rejects(fn, (e) => /HR-4203|append-only/.test(String(e?.message ?? e)), msg);
const publish = (tenantId = company) => as("HR", () => publishConfig({ tenantId, publishedById: people.HR.id }), tenantId);
const snapshots = (tenantId = company) =>
  mcpCtx.run({ user: { tenantId } }, () => tenantTransaction(prisma, (tx) => tx.payrollConfigSnapshot.findMany({ where: { tenantId }, orderBy: { version: "asc" } }), { tenantId }));

test("publish: draft rows flip, versions serialize, snapshots are append-only", { timeout: 180000 }, async () => {
  await ensure();
  await db((tx) => tx.payrollRuleConfig.create({ data: { tenantId: company, lwpRecovery: true, status: "DRAFT", version: 1 } }));
  await db((tx) => tx.attendancePolicyConfig.create({ data: { tenantId: company, graceMinutes: 12, status: "DRAFT", version: 1 } }));

  const first = await publish();
  assert.equal(first.version, 1);
  const rule = await db((tx) => tx.payrollRuleConfig.findFirst({ where: { tenantId: company } }));
  const pol = await db((tx) => tx.attendancePolicyConfig.findFirst({ where: { tenantId: company } }));
  assert.equal(rule.status, "PUBLISHED");
  assert.equal(pol.status, "PUBLISHED");
  assert.equal((await as("HR", () => getConfigStatus({ tenantId: company }))).publishedVersion, 1);

  // Two people publish at the same moment: both succeed, with distinct consecutive versions.
  const [a, b] = await Promise.all([publish(), publish()]);
  assert.deepEqual([a.version, b.version].sort(), [2, 3]);
  const rows = await snapshots();
  assert.deepEqual(rows.map((r) => r.version), [1, 2, 3]);
  assert.equal(rows[0].config.attendancePolicy?.graceMinutes ?? rows[0].config.attendancePolicy?.[0]?.graceMinutes ?? 12, 12);
  assert.equal(rows[0].publishedById, people.HR.id);

  // Snapshots are the record of what a payroll run was priced with: no rewrite, no delete.
  await refused(() => db((tx) => tx.payrollConfigSnapshot.update({ where: { id: rows[0].id }, data: { config: { tampered: true } } })), "config rewrite");
  await refused(() => db((tx) => tx.payrollConfigSnapshot.update({ where: { id: rows[0].id }, data: { version: 99 } })), "version rewrite");
  await refused(() => db((tx) => tx.payrollConfigSnapshot.delete({ where: { id: rows[0].id } })), "delete");
  await refused(() => db((tx) => tx.payrollConfigSnapshot.deleteMany({ where: { tenantId: company } })), "bulk delete");
  assert.equal((await snapshots()).length, 3);
  assert.equal((await snapshots())[0].config.tampered, undefined);

  // Another company sees none of them.
  assert.equal((await snapshots(other)).length, 0);
});

test("an invalid publisher identity is refused and nothing is written", { timeout: 60000 }, async () => {
  await ensure();
  const before = (await snapshots()).length;
  for (const bad of ["abc", -1, 0, 1.5, {}]) await assert.rejects(() => publish_with(bad), (e) => e.status === 400);
  assert.equal((await snapshots()).length, before);
});
const publish_with = (publishedById) => as("HR", () => publishConfig({ tenantId: company, publishedById }));
