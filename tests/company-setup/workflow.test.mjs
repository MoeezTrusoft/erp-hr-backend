import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { samplePolicy } from "./policy.mjs";
import { randomUUID, generateKeyPairSync } from "node:crypto";
const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).pathname !== "/hr_task_assessment_test"
)
  throw new Error("Use isolated HR test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
const keys = generateKeyPairSync("ed25519");
process.env.SERVICE_JWT_PRIVATE_KEY_PEM = keys.privateKey.export({
  type: "pkcs8",
  format: "pem",
});
process.env.SERVICE_JWT_CURRENT_KID = "setup-test";
let remote = { accounts: [], departments: ["HR", "IT", "Finance"] },
  outage = false,
  failApply = false,
  applied = new Map();
const peer = http.createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const rpc = JSON.parse(body);
  res.setHeader("content-type", "application/json");
  if (outage) {
    res.statusCode = 503;
    res.end("{}");
    return;
  }
  let value = remote,
    isError = false;
  if (rpc.params.name === "rbac_hr_setup_identity_apply") {
    if (failApply) {
      value = { error: "Temporary account service failure" };
      isError = true;
    } else {
      const p = JSON.parse(
        Buffer.from(rpc.params.arguments.proof.split(".")[1], "base64url"),
      ).plan;
      applied.set(p.reviewRef, p);
      value = { reviewRef: p.reviewRef, digest: p.digest, applied: true };
    }
  }
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        isError,
        content: [{ type: "text", text: JSON.stringify(value) }],
      },
    }),
  );
});
await new Promise((r) => peer.listen(0, "127.0.0.1", r));
process.env.RBAC_SERVICE_URL = `http://127.0.0.1:${peer.address().port}`;
const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { saveSetup, actSetup, readSetup, overviewSetup } =
  await import("../../src/services/company-setup/service.js");
const { configureSeparation } =
  await import("../../src/services/separation/service.js");
const company = randomUUID(),
  other = randomUUID(),
  people = {};
const permissions = {
  HR: ["read", "prepare", "activate"],
  HR2: ["read", "prepare", "activate"],
  CEO: ["read", "approve"],
  EMP: ["read"],
  ADMIN: [],
};
const as = (who, fn, tenantId = company) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId, userId: people[who].userId, isAdmin: who === "ADMIN" },
      permissions: permissions[who].map((p) => "hr.setup." + p),
    },
    fn,
  );
const db = (fn) =>
  mcpCtx.run({ user: { tenantId: company } }, () =>
    tenantTransaction(prisma, fn, { tenantId: company }),
  );
const save = (data, extra = {}) =>
  as("HR", () =>
    saveSetup({
      kind: "EMPLOYEE_SETUP",
      employeeCode: people.EMP.employee_code,
      expectedVersion: 0,
      data,
      evidenceRefs: ["controlled-doc:contract"],
      reason: "Verified against signed HR records",
      requestKey: randomUUID(),
      ...extra,
    }),
  ).then((r) => r.record);
const act = (who, row, action, extra = {}) =>
  as(who, () =>
    actSetup({
      reviewRef: row.reviewRef,
      expectedVersion: row.version,
      action,
      reason: "Evidence and company scope verified",
      requestKey: randomUUID(),
      ...extra,
    }),
  ).then((r) => r.record);
const fresh = (ref) =>
  as("HR", () => readSetup({ reviewRef: ref })).then((r) => r.record);
async function approved(row) {
  row = await act("HR", row, "SUBMIT");
  return act("CEO", row, "APPROVE");
}
test(
  "company setup: approved activation, isolation, conflicts and recovery",
  { timeout: 120000 },
  async (t) => {
    try {
      await db(async (tx) => {
        const grade = await tx.gradeLevel.create({
          data: { tenantId: company, name: "G1" },
        });
        let i = 0;
        for (const who of Object.keys(permissions)) {
          people[who] = await tx.employee.create({
            data: {
              tenant_id: company,
              employee_code: (who === "CEO" ? "MGMT-" : "EMP-") + (9701 + i++),
              first_name: "Fictional",
              last_name: who,
              status: "Active",
              employement_status: "Active",
              employeeCategory: who === "CEO" ? "MANAGEMENT" : "EMPLOYEE",
              gradeLevelId: grade.id,
              contractNoticeDays: 30,
              userId: 1000000 + Math.floor(Math.random() * 1e8),
            },
          });
        }
        for (const who of Object.keys(people).filter((w) => w !== "CEO"))
          await tx.employee.update({
            where: { id: people[who].id },
            data: { managerId: people.CEO.id },
          });
      });
      // Reproduce a record that predates the mandatory-category migration.
      // Only the disposable fixture administrator can bypass the insert guard.
      const adminUrl = process.env.ASSESSMENT_TEST_ADMIN_URL;
      if (
        !adminUrl ||
        new URL(adminUrl).hostname !== "127.0.0.1" ||
        new URL(adminUrl).pathname !== "/hr_task_assessment_test"
      )
        throw new Error("Isolated fixture administrator required");
      const pg = createRequire(
        createRequire(import.meta.url).resolve("@prisma/adapter-pg"),
      )("pg");
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await admin.query("BEGIN; SET LOCAL session_replication_role=replica");
        await admin.query(
          'UPDATE "Employee" SET "employeeCategory"=NULL WHERE id=$1 AND tenant_id=$2',
          [people.EMP.id, company],
        );
        await admin.query("COMMIT");
      } finally {
        await admin.end();
      }
      remote.accounts = Object.values(people).map((e) => ({
        userId: e.userId,
        login: e.employee_code.toLowerCase() + "@example.test",
        member: true,
        enabled: true,
        employeeCode: e.employee_code,
        hrEmployeeId: e.id,
        fingerprint: "a".repeat(64),
        permissions: [
          "hr.setup.approve",
          "hr.separation.verify",
          "hr.separation.approve",
          "hr.separation.task",
        ],
      }));
      await t.test(
        "ordinary admin and other companies cannot access reviews",
        async () => {
          await assert.rejects(
            as("ADMIN", () => overviewSetup({})),
            /Requires/,
          );
          await assert.rejects(
            as("HR", () => overviewSetup({}), other),
            /linked employee/,
          );
        },
      );
      let row;
      await t.test(
        "drafts preserve live data; evidence and independent approval required",
        async () => {
          row = await save({ category: "EMPLOYEE" }, { evidenceRefs: [] });
          assert.equal(
            (
              await db((tx) =>
                tx.employee.findUnique({ where: { id: people.EMP.id } }),
              )
            ).employeeCategory,
            null,
          );
          await assert.rejects(act("HR", row, "SUBMIT"), /evidence/);
          row = await save(
            { category: "EMPLOYEE" },
            { reviewRef: row.reviewRef, expectedVersion: row.version },
          );
          row = await act("HR", row, "SUBMIT");
          await assert.rejects(act("HR", row, "APPROVE"), /Requires/);
          permissions.HR.push("approve");
          await assert.rejects(act("HR", row, "APPROVE"), /not available/);
          permissions.HR.pop();
          row = await act("CEO", row, "APPROVE");
          assert.equal(row.state, "APPROVED");
        },
      );
      await t.test(
        "Management return goes to HR; edits clear approval and protect source versions",
        async () => {
          row = await act("CEO", row, "REVERT");
          assert.equal(row.state, "RETURNED");
          row = await save(
            { category: "EMPLOYEE" },
            { reviewRef: row.reviewRef, expectedVersion: row.version },
          );
          row = await approved(row);
          await db((tx) =>
            tx.employee.update({
              where: { id: people.EMP.id },
              data: { contractNoticeDays: 45 },
            }),
          );
          await assert.rejects(
            act("HR", row, "ACTIVATE"),
            /Source records changed/,
          );
          row = await act("CEO", row, "REVERT");
          row = await save(
            { category: "EMPLOYEE" },
            { reviewRef: row.reviewRef, expectedVersion: row.version },
          );
          row = await approved(row);
        },
      );
      await t.test(
        "activation is atomic and idempotent; audit and approved content cannot be rewritten",
        async () => {
          const key = randomUUID(),
            old = row;
          row = await act("HR", old, "ACTIVATE", { requestKey: key });
          assert.equal(row.state, "ACTIVE");
          const again = await act("HR", old, "ACTIVATE", { requestKey: key });
          assert.equal(again.version, row.version);
          assert.equal(
            (
              await db((tx) =>
                tx.employee.findUnique({ where: { id: people.EMP.id } }),
              )
            ).employeeCategory,
            "EMPLOYEE",
          );
          await assert.rejects(act("HR", old, "ACTIVATE"), /changed/);
          await assert.rejects(
            db((tx) =>
              tx.hrSetupAudit.updateMany({
                where: { reviewRef: row.reviewRef },
                data: { reason: "tamper" },
              }),
            ),
            /append-only/,
          );
          await assert.rejects(
            db((tx) =>
              tx.hrSetupReview.update({
                where: { id: row.reviewRef },
                data: { payload: { tamper: true }, version: { increment: 1 } },
              }),
            ),
            /immutable/,
          );
          const stored = await db((tx) =>
            tx.hrSetupReview.findUnique({ where: { id: row.reviewRef } }),
          );
          assert.ok(stored.payload.encrypted.startsWith("c4.v1:"));
          assert.ok(!JSON.stringify(row).includes("userId"));
        },
      );
      await t.test(
        "employee setup prevents category conversion and reporting-line cycles",
        async () => {
          const r = await save({ managerCode: people.EMP.employee_code });
          await assert.rejects(act("HR", r, "SUBMIT"), /cycle/);
          const changed = await save(
            { category: "MANAGEMENT" },
            { reviewRef: r.reviewRef, expectedVersion: r.version },
          );
          await assert.rejects(
            act("HR", changed, "SUBMIT"),
            /conversion workflow/,
          );
        },
      );
      await t.test(
        "identity approval cannot replace an existing primary login",
        async () => {
          const r = await save(
            {
              login: remote.accounts.find((a) => a.userId === people.HR2.userId)
                .login,
              action: "LINK_EMPLOYEE",
              employeeCode: people.EMP.employee_code,
              clarification: "Documented proposed employee identity",
            },
            { kind: "IDENTITY", employeeCode: undefined },
          );
          await assert.rejects(
            act("HR", r, "SUBMIT"),
            /different primary login/,
          );
        },
      );
      await t.test(
        "identity partial failure reserves ownership and supports safe retry with audit",
        async () => {
          let r = await save(
            {
              login: remote.accounts.find((a) => a.userId === people.EMP.userId)
                .login,
              action: "REMOVE_COMPANY_ACCESS",
              clarification:
                "Duplicate company account confirmed by employee and HR",
            },
            { kind: "IDENTITY", employeeCode: undefined },
          );
          r = await approved(r);
          failApply = true;
          r = await act("HR", r, "ACTIVATE");
          assert.equal(r.state, "ACTIVATING");
          assert.ok(r.failure);
          assert.equal(
            (
              await db((tx) =>
                tx.employee.findUnique({ where: { id: people.EMP.id } }),
              )
            ).userId,
            people.EMP.userId,
          );
          await assert.rejects(
            db((tx) =>
              tx.employee.update({
                where: { id: people.EMP.id },
                data: { userId: people.HR2.userId },
              }),
            ),
            /pending/,
          );
          failApply = false;
          r = await act("HR2", r, "RETRY");
          assert.equal(r.state, "ACTIVE");
          assert.equal(
            (
              await db((tx) =>
                tx.employee.findUnique({ where: { id: people.EMP.id } }),
              )
            ).userId,
            null,
          );
          assert.equal(applied.size, 1);
          assert.ok(r.history.some((h) => h.action === "ACTIVATION_PENDING"));
          assert.ok(r.history.some((h) => h.action === "ACTIVATE_COMPLETED"));
        },
      );
      await t.test(
        "policy requires staged approval and readiness; dependency outage is explicit",
        async () => {
          assert.throws(() => configureSeparation({}), /Management approval/);
          await assert.rejects(
            db((tx) =>
              tx.separationPolicy.create({
                data: {
                  tenantId: company,
                  actorCode: people.HR.employee_code,
                  policy: {},
                },
              }),
            ),
            /Management-approved/,
          );
          let r = await save(
            { policy: {} },
            { kind: "POLICY", employeeCode: undefined },
          );
          await assert.rejects(act("HR", r, "SUBMIT"));
          outage = true;
          const overview = await as("HR", () => overviewSetup({}));
          assert.equal(overview.overview.identityAvailable, false);
          assert.match(overview.overview.identityWarning, /unavailable/);
          outage = false;
          let identity = await save(
            {
              login: remote.accounts.find((a) => a.userId === people.EMP.userId)
                .login,
              action: "LINK_EMPLOYEE",
              employeeCode: people.EMP.employee_code,
              clarification:
                "Employee account confirmed against signed identity evidence",
            },
            { kind: "IDENTITY", employeeCode: undefined },
          );
          identity = await approved(identity);
          identity = await act("HR", identity, "ACTIVATE");
          assert.equal(identity.state, "ACTIVE");
          r = await save(
            samplePolicy(people.HR.employee_code, people.CEO.employee_code),
            {
              kind: "POLICY",
              employeeCode: undefined,
              reviewRef: r.reviewRef,
              expectedVersion: r.version,
            },
          );
          r = await approved(r);
          await db((tx) =>
            tx.employee.update({
              where: { id: people.HR2.id },
              data: { managerId: null },
            }),
          );
          await assert.rejects(
            act("HR", r, "ACTIVATE"),
            /line manager missing/,
          );
          await db((tx) =>
            tx.employee.update({
              where: { id: people.HR2.id },
              data: { managerId: people.CEO.id },
            }),
          );
          r = await act("HR", r, "ACTIVATE");
          assert.equal(r.state, "ACTIVE");
          assert.equal(
            (
              await db((tx) =>
                tx.separationPolicy.findUnique({
                  where: { tenantId: company },
                }),
              )
            ).approvalReviewRef,
            r.reviewRef,
          );
        },
      );
      await t.test(
        "approved reassignment clears the reviewed old link and assigns an unoccupied company employee",
        async () => {
          const target = await db((tx) =>
            tx.employee.create({
              data: {
                tenant_id: company,
                employee_code: "EMP-9799",
                employeeCategory: "EMPLOYEE",
                first_name: "Fictional reassignment",
                status: "Active",
                employement_status: "Active",
              },
            }),
          );
          let r = await save(
            {
              login: remote.accounts.find(
                (a) => a.userId === people.ADMIN.userId,
              ).login,
              action: "LINK_EMPLOYEE",
              employeeCode: target.employee_code,
              clarification:
                "Corrected the primary employee using verified identity evidence",
            },
            { kind: "IDENTITY", employeeCode: undefined },
          );
          r = await approved(r);
          r = await act("HR", r, "ACTIVATE");
          assert.equal(r.state, "ACTIVE");
          assert.equal(
            (
              await db((tx) =>
                tx.employee.findUnique({ where: { id: people.ADMIN.id } }),
              )
            ).userId,
            null,
          );
          assert.equal(
            (
              await db((tx) =>
                tx.employee.findUnique({ where: { id: target.id } }),
              )
            ).userId,
            people.ADMIN.userId,
          );
        },
      );
      await t.test(
        "FORCE RLS hides company reviews from other company transactions",
        async () => {
          const rows = await mcpCtx.run({ user: { tenantId: other } }, () =>
            tenantTransaction(
              prisma,
              (tx) => tx.hrSetupReview.findMany({ where: { tenantId: other } }),
              { tenantId: other },
            ),
          );
          assert.deepEqual(rows, []);
        },
      );
    } finally {
      await prisma.$disconnect();
      await new Promise((r) => peer.close(r));
    }
  },
);
