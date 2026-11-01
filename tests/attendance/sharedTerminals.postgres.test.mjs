import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID } from "node:crypto";
const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/hr_task_assessment_test")
  throw new Error("Use an isolated local HR test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { captureOverview } = await import("../../src/services/attendanceCapture.service.js");

const company = randomUUID(), other = randomUUID(), intake = randomUUID();
process.env.HR_ATTENDANCE_INTAKE_TENANT_ID = intake;
const sns = { shared: `SHARED-${randomUUID().slice(0, 8)}`, foreign: `FOREIGN-${randomUUID().slice(0, 8)}`, own: `OWN-${randomUUID().slice(0, 8)}` };
const make = (tenantId, sn, allowed) => ({ tenantId, sn, name: `Device ${sn}`, timeZone: "Asia/Karachi", active: false, allowedTenantIds: allowed });

test("a company sees the intake terminals that serve it, and its own, but not another company's", async () => {
  for (const [tenantId, sn, allowed] of [
    [intake, sns.shared, [intake, company]],
    [intake, sns.foreign, [intake, other]],
    [company, sns.own, [company]],
  ])
    await mcpCtx.run({ system: true, user: { tenantId } }, () =>
      tenantTransaction(prisma, (tx) => tx.attendanceCaptureDevice.create({ data: make(tenantId, sn, allowed) }), { tenantId }),
    );
  // A normal company session (not a system job): the lookup must work inside it.
  const overview = await mcpCtx.run({ user: { tenantId: company, permissions: [] } }, () => captureOverview({ tenantId: company }));
  const bySn = new Map(overview.devices.map((d) => [d.sn, d]));
  assert.ok(bySn.has(sns.own), "own device listed");
  assert.equal(bySn.get(sns.own).shared, undefined);
  assert.ok(bySn.has(sns.shared), "intake terminal serving this company listed");
  assert.equal(bySn.get(sns.shared).shared, true);
  assert.equal(bySn.has(sns.foreign), false, "another company's terminal is not listed");
  assert.equal("credentialHash" in bySn.get(sns.shared), false, "no secrets leak");
});

after(() => prisma.$disconnect());
