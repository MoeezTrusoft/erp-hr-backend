import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import { canonicalAppraisalPermission } from "@trusoft/contracts/performance-appraisals";
process.env.DATABASE_URL =
  "postgresql://appraisal_runtime@127.0.0.1:55443/performance_appraisals_test";
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const { default: prisma } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const S = await import("../../src/services/appraisals/core.js");
const Q = await import("../../src/services/appraisals/queries.js");
const X = await import("../../src/services/appraisals/continuous.js");
const { default: express } = await import("express");
const { default: request } = await import("supertest");
const { default: router } =
  await import("../../src/routes/appraisals.routes.js");
const { registerAppraisalTools } =
  await import("../../src/mcp/tools/appraisalTools.js");
const { resolveHrRoutePolicy } =
  await import("../../src/middlewares/routeAuthorization.middleware.js");
const { APPRAISAL_TOOLS } =
  await import("@trusoft/contracts/performance-appraisals");
const D = await import("../../src/services/appraisals/decisions.js");
const A = await import("../../src/services/approval/service.js");
const tenant = randomUUID(),
  other = randomUUID();
const people = {};
const permissions = [
  "read",
  "read.all",
  "configure",
  "cycle.manage",
  "response.write",
  "approve",
  "calibrate",
  "calibrate.approve",
  "release",
  "appeal",
  "appeal.decide",
  "goal.write",
  "goal.approve",
  "checkin.write",
  "feedback.write",
  "feedback.hr",
  "decision.propose",
  "compensation.propose",
  "compensation.read",
  "decision.read",
  "decision.approve",
  "decision.hr",
  "decision.budget",
  "decision.execute",
  "audit",
  "peer.manage",
  "peer.respond",
].map((x) => "hr.performance." + x);
const as = (name, fn, perms = permissions, tid = tenant) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tid, userId: people[name].userId, isAdmin: false },
      permissions: perms.map(canonicalAppraisalPermission),
      correlationId: randomUUID(),
    },
    fn,
  );
const db = (fn) =>
  as("HR", () => tenantTransaction(prisma, fn, { tenantId: tenant }));
const key = () => randomUUID();
const versioned = (row) => ({
  id: row.id,
  expectedVersion: row.version,
  requestKey: key(),
});
const rubric = {
  schemaVersion: 1,
  scaleMin: 1,
  scaleMax: 5,
  anchors: [1, 2, 3, 4, 5].map((value) => ({
    value,
    label: "Anchor " + value,
  })),
  criteria: [
    {
      id: "delivery",
      label: "Delivery",
      weight: 10000,
      required: true,
      evidenceRequired: false,
      allowNA: false,
    },
  ],
  bands: [
    { min: 0, label: "Developing" },
    { min: 50, label: "Effective" },
  ],
};
const answers = [
  {
    criterionId: "delivery",
    rating: 4,
    narrative: "Accepted work outcomes",
    evidenceIds: [],
  },
];
let template, cycle, r;
test(
  "PostgreSQL appraisal workflow, confidentiality, isolation and concurrency",
  { timeout: 90000 },
  async (t) => {
    const admin = new pg.Client({
      connectionString:
        "postgresql://appraisal_admin@127.0.0.1:55443/performance_appraisals_test",
    });
    await admin.connect();
    const runtime = new pg.Client({
      connectionString: process.env.DATABASE_URL,
    });
    await runtime.connect();
    try {
      for (const [index, name] of [
        "HR",
        "MANAGER",
        "EMPLOYEE",
        "CALIBRATOR",
        "RELEASER",
        "APPEAL",
        "BUDGET",
        "EXECUTOR",
        "NEW_MANAGER",
      ].entries()) {
        const uid = Math.floor(Math.random() * 100000000) + index;
        const row = await admin.query(
          'INSERT INTO "Employee" (tenant_id,"userId",employee_code,employement_status,first_name,version,updated_at) VALUES($1,$2,$3,$4,$5,0,CURRENT_TIMESTAMP) RETURNING id,"userId",employee_code',
          [tenant, uid, tenant.slice(0, 8) + "-" + name, "Active", name],
        );
        people[name] = row.rows[0];
      }
      await admin.query('UPDATE "Employee" SET "managerId"=$1 WHERE id=$2', [
        people.MANAGER.id,
        people.EMPLOYEE.id,
      ]);
      await t.test(
        "Runtime is not an owner, superuser or RLS bypass role",
        async () => {
          const row = (
            await runtime.query(
              "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
            )
          ).rows[0];
          assert.equal(row.rolsuper, false);
          assert.equal(row.rolbypassrls, false);
        },
      );
      const { legacyRegressions } = await import("./legacy-regressions.mjs");
      await legacyRegressions(t, { as, tenant, other, people, db, admin });
      const policy = {
        schemaVersion: 1,
        approvedReference: "TEST-POLICY",
        calendarVersion: "TEST-CALENDAR",
        holidays: [],
        weekendDays: [0, 6],
        seniorApprovalRequired: true,
        requireEvidence: false,
        appealDays: 10,
        appealDecisionDays: 15,
        peerMinimum: 5,
        retentionClass: "TEST",
      };
      await as("HR", () =>
        S.configure({
          requestKey: key(),
          expectedVersion: 0,
          coreEnabled: true,
          policy,
        }),
      );
      await t.test(
        "Read grants do not authorise configuration writes",
        async () => {
          await assert.rejects(
            as(
              "EMPLOYEE",
              () =>
                S.configure({
                  requestKey: key(),
                  expectedVersion: 1,
                  coreEnabled: false,
                  policy,
                }),
              ["hr.performance.read"],
            ),
            (e) => e.status === 403,
          );
        },
      );
      template = await as("HR", () =>
        S.templateCreate({ requestKey: key(), name: key(), rubric }),
      );
      template = await as("HR", () => S.templatePublish(versioned(template)));
      await t.test(
        "Published templates cannot be mutated by runtime SQL",
        async () => {
          await assert.rejects(
            db((tx) =>
              tx.perfTemplateVersion.update({
                where: { id: template.id },
                data: { rubric: {} },
              }),
            ),
            /immutable/,
          );
        },
      );
      cycle = await as("HR", () =>
        S.cycleCreate({
          requestKey: key(),
          name: key(),
          templateId: template.id,
          periodStart: "2026-01-01",
          periodEnd: "2027-12-31",
          timezone: "Asia/Karachi",
          selfDue: "2027-06-01T12:00:00Z",
          managerDue: "2027-06-15T12:00:00Z",
        }),
      );
      const launch = { ...versioned(cycle), employeeIds: [people.EMPLOYEE.id] };
      cycle = await as("HR", () => S.cycleLaunch(launch));
      await t.test(
        "Durable launch replay is exact and content reuse is rejected",
        async () => {
          assert.deepEqual(await as("HR", () => S.cycleLaunch(launch)), cycle);
          await assert.rejects(
            as("HR", () =>
              S.cycleLaunch({ ...launch, employeeIds: [people.MANAGER.id] }),
            ),
            (e) => e.code === "IDEMPOTENCY_CONFLICT",
          );
        },
      );
      await t.test(
        "Launch pause, queue recovery and a failed batch preserve the frozen roster",
        async () => {
          let run = await db((tx) =>
            tx.perfLaunchRun.findFirst({
              where: { tenantId: tenant, cycleId: cycle.id },
            }),
          );
          assert.equal(cycle.jobId, run.jobId);
          assert.equal(cycle.launchRunId, run.id);
          await assert.rejects(
            as("HR", () =>
              S.cycleTransition({
                ...versioned(cycle),
                action: "CALIBRATE",
                reason: "Too early",
              }),
            ),
            (e) => e.code === "LAUNCH_NOT_COMPLETE",
          );
          run = await as("HR", () =>
            S.launchControl({
              ...versioned(run),
              action: "PAUSE",
              reason: "Recovery test",
            }),
          );
          assert.equal(
            (await db((tx) => S.launchBatch(tx, tenant, cycle.id))).created,
            0,
          );
          run = await as("HR", () =>
            S.launchControl({
              ...versioned(run),
              action: "RESUME",
              reason: "Resume frozen roster",
            }),
          );
          const { reconcileLaunches } =
            await import("../../src/services/appraisals/jobs.js");
          const queued = [];
          const queue = {
            getJob: async (id) => queued.find((j) => j.id === id),
            add: async (name, data, opts) =>
              queued.push({
                id: opts.jobId,
                name,
                data,
                getState: async () => "waiting",
              }),
          };
          await reconcileLaunches(queue, tenant);
          await reconcileLaunches(queue, tenant);
          assert.equal(queued.length, 1);
          assert.equal(queued[0].id, cycle.jobId);
          assert.equal(queued[0].data.cycleId, cycle.id);
          await assert.rejects(
            db(async (tx) => {
              await S.launchBatch(tx, tenant, cycle.id);
              throw new Error("Simulated worker crash before commit");
            }),
            /Simulated worker crash/,
          );
          const unchanged = await db((tx) =>
            tx.perfLaunchRun.findFirst({ where: { id: run.id } }),
          );
          assert.equal(unchanged.processed, 0);
          assert.equal(
            await db((tx) =>
              tx.perfReview.count({
                where: { tenantId: tenant, cycleId: cycle.id },
              }),
            ),
            0,
          );
          assert.equal(
            await db((tx) =>
              tx.perfLaunchBatch.count({
                where: { tenantId: tenant, runId: run.id },
              }),
            ),
            0,
          );
        },
      );
      await t.test(
        "Batch retry creates one canonical review from the frozen roster",
        async () => {
          await db((tx) => S.launchBatch(tx, tenant, cycle.id));
          await db((tx) => S.launchBatch(tx, tenant, cycle.id));
          assert.equal(
            await db((tx) =>
              tx.perfReview.count({
                where: { tenantId: tenant, cycleId: cycle.id },
              }),
            ),
            1,
          );
          const run = await db((tx) =>
            tx.perfLaunchRun.findFirst({
              where: { tenantId: tenant, cycleId: cycle.id },
            }),
          );
          assert.equal(run.state, "SUCCEEDED");
          assert.equal(run.processed, run.total);
          const batches = await db((tx) =>
            tx.perfLaunchBatch.findMany({
              where: { tenantId: tenant, runId: run.id },
            }),
          );
          assert.equal(batches.length, 1);
          assert.equal(batches[0].count, 1);
          await assert.rejects(
            db((tx) =>
              tx.perfLaunchBatch.update({
                where: { id: batches[0].id },
                data: { count: 2 },
              }),
            ),
          );
        },
      );
      r = (
        await as("EMPLOYEE", () => Q.list({ kind: "reviews" }), [
          "hr.performance.read",
        ])
      ).items[0];
      const { notificationRegressions } = await import('./notification-regressions.mjs');
      await notificationRegressions(t, { tenant, other, people, db, admin, reviewId: r.id });
      const { peerRegressions } = await import("./peer-regressions.mjs");
      await peerRegressions(t, {
        as,
        tenant,
        other,
        people,
        db,
        reviewId: r.id,
      });
      await t.test(
        "Missing tenant context and other tenants cannot read the review",
        async () => {
          assert.equal(
            (
              await runtime.query('SELECT * FROM "PerfReview" WHERE id=$1', [
                r.id,
              ])
            ).rowCount,
            0,
          );
          await runtime.query("BEGIN");
          await runtime.query("SELECT set_config('app.tenant_id',$1,true)", [
            other,
          ]);
          assert.equal(
            (
              await runtime.query('SELECT * FROM "PerfReview" WHERE id=$1', [
                r.id,
              ])
            ).rowCount,
            0,
          );
          await runtime.query("ROLLBACK");
        },
      );
      await t.test(
        "Manager cannot submit without employee response or HR waiver",
        async () => {
          await assert.rejects(
            as("MANAGER", () =>
              S.transition({ ...versioned(r), action: "SUBMIT_MANAGER" }),
            ),
            (e) => e.code === "SELF_RESPONSE_REQUIRED",
          );
        },
      );
      r = await as("EMPLOYEE", () =>
        S.responseSave({ ...versioned(r), role: "SELF", answers }),
      );
      await t.test(
        "Failed transactions roll back audit, outbox and receipt together",
        async () => {
          const B = await import("../../src/services/appraisals/base.js");
          const before = await db(async (tx) => [
            await tx.perfAudit.count({ where: { aggregateId: r.id } }),
            await tx.outboxEvent.count({
              where: { tenantId: tenant, aggregateId: r.id },
            }),
          ]);
          const requestKey = key();
          await assert.rejects(
            as("HR", () =>
              B.run(
                "rollback-proof",
                { requestKey },
                "hr.performance.audit",
                async (tx, e) => {
                  await B.audit(tx, e, "TEST_ROLLBACK", r.id, r.version, {});
                  await B.event(tx, e, "test_rollback", {
                    ...r,
                    cycleId: cycle.id,
                  });
                  throw Object.assign(
                    new Error("Injected downstream failure"),
                    { status: 422 },
                  );
                },
              ),
            ),
          );
          const after = await db(async (tx) => [
            await tx.perfAudit.count({ where: { aggregateId: r.id } }),
            await tx.outboxEvent.count({
              where: { tenantId: tenant, aggregateId: r.id },
            }),
          ]);
          assert.deepEqual(after, before);
          assert.equal(
            await db((tx) =>
              tx.perfCommandReceipt.count({ where: { requestKey } }),
            ),
            0,
          );
        },
      );
      await t.test(
        "Concurrent saves commit one winner and retain one response",
        async () => {
          const before = r.version;
          const results = await Promise.allSettled(
            ["First", "Second"].map((narrative) =>
              as("EMPLOYEE", () =>
                S.responseSave({
                  ...versioned(r),
                  role: "SELF",
                  answers: [{ ...answers[0], narrative }],
                }),
              ),
            ),
          );
          assert.equal(
            results.filter((x) => x.status === "fulfilled").length,
            1,
          );
          assert.equal(
            results.find((x) => x.status === "rejected").reason.status,
            412,
          );
          r = results.find((x) => x.status === "fulfilled").value;
          assert.equal(r.version, before + 1);
          assert.equal(
            await db((tx) =>
              tx.perfResponse.count({
                where: { reviewId: r.id, role: "SELF" },
              }),
            ),
            1,
          );
        },
      );
      await t.test(
        "REST and MCP handlers share schemas, permission manifest and durable receipts",
        async () => {
          const registry = {};
          registerAppraisalTools({
            registerTool(name, definition, handler) {
              registry[name] = { definition, handler };
            },
          });
          for (const [name, [permission]] of Object.entries(APPRAISAL_TOOLS)) {
            assert.ok(registry[name]);
            const path =
              "/api/hr/appraisals/" + name.replace("hr_appraisal_", "");
            assert.equal(
              resolveHrRoutePolicy({
                route: {},
                method: "POST",
                originalUrl: path,
              }).permission,
              permission,
            );
            assert.equal(
              resolveHrRoutePolicy({
                route: {},
                method: "GET",
                originalUrl: path,
              }),
              null,
            );
          }
          const app = express();
          app.use(express.json());
          app.use((req, res, next) =>
            as("EMPLOYEE", next, [
              "hr.performance.read",
              "hr.performance.response.write",
            ]),
          );
          app.use("/api/hr/appraisals", router);
          const path = "/api/hr/appraisals/response_save",
            input = { ...versioned(r), role: "SELF", answers };
          assert.equal((await request(app).post(path).send(input)).status, 428);
          assert.equal(
            (
              await request(app)
                .post(path)
                .set("If-Match", '"' + r.version)
                .send(input)
            ).status,
            422,
          );
          assert.equal(
            (await request(app).post(path).set("If-Match", '"0"').send(input))
              .status,
            422,
          );
          const invalid = { ...input, tenantId: other };
          assert.equal(
            (
              await request(app)
                .post(path)
                .set("If-Match", String(r.version))
                .send(invalid)
            ).status,
            422,
          );
          const denied = await as(
            "EMPLOYEE",
            () => registry.hr_appraisal_response_save.handler(input),
            ["hr.performance.read"],
          );
          assert.equal(JSON.parse(denied.content[0].text).code, "FORBIDDEN");
          const mcp = await as("EMPLOYEE", () =>
            registry.hr_appraisal_response_save.handler(input),
          );
          assert.equal(mcp.isError, undefined);
          r = JSON.parse(mcp.content[0].text);
          const replay = await request(app)
            .post(path)
            .set("If-Match", String(input.expectedVersion))
            .send(input);
          assert.equal(replay.status, 200);
          assert.deepEqual(replay.body, r);
          assert.equal(replay.headers.etag, '"' + r.version + '"');
        },
      );
      await t.test(
        "Stale writes fail without replacing the draft",
        async () => {
          await assert.rejects(
            as("EMPLOYEE", () =>
              S.responseSave({
                ...versioned(r),
                expectedVersion: 0,
                role: "SELF",
                answers,
              }),
            ),
            (e) => e.status === 412,
          );
        },
      );
      r = await as("EMPLOYEE", () =>
        S.transition({ ...versioned(r), action: "SUBMIT_SELF" }),
      );
      await t.test(
        "Submitted responses are immutable at the database",
        async () => {
          const response = await db((tx) =>
            tx.perfResponse.findFirst({ where: { reviewId: r.id } }),
          );
          await assert.rejects(
            db((tx) =>
              tx.perfResponse.update({
                where: { id: response.id },
                data: { answers: [] },
              }),
            ),
            /immutable/,
          );
        },
      );
      r = await as("MANAGER", () =>
        S.responseSave({
          ...versioned(r),
          role: "MANAGER",
          answers: [{ ...answers[0], narrative: "Confidential manager draft" }],
        }),
      );
      await t.test(
        "Employee cannot read manager draft before release",
        async () => {
          const detail = await as("EMPLOYEE", () => Q.get({ id: r.id }), [
            "hr.performance.read",
          ]);
          assert.equal(
            detail.responses.some((x) => x.role === "MANAGER"),
            false,
          );
          assert.equal(detail.revision, null);
        },
      );
      r = await as("MANAGER", () =>
        S.transition({ ...versioned(r), action: "SUBMIT_MANAGER" }),
      );
      await t.test(
        "Subject and evaluator cannot approve their own outcome",
        async () => {
          await assert.rejects(
            as("MANAGER", () =>
              S.transition({ ...versioned(r), action: "APPROVE_SENIOR" }),
            ),
            (e) => e.code === "INDEPENDENT_APPROVER_REQUIRED",
          );
        },
      );
      await t.test(
        "Approval Centre hides draft packets and binds senior approval to its exact version",
        async () => {
          const queue = await as("HR", () =>
            A.listApprovals({ scope: "QUEUE", kind: "PERFORMANCE" }),
          );
          const request = queue.items.find((x) => x.sourceRef.includes(r.id));
          assert.ok(request);
          const mine = await as(
            "EMPLOYEE",
            () => A.listApprovals({ scope: "MINE" }),
            ["hr.performance.read"],
          );
          assert.ok(
            !mine.items.some((x) => x.approvalRef === request.approvalRef),
          );
          await assert.rejects(
            as(
              "EMPLOYEE",
              () => A.readApproval({ approvalRef: request.approvalRef }),
              ["hr.performance.read"],
            ),
            (e) => e.status === 404,
          );
          await assert.rejects(
            as("MANAGER", () =>
              A.actApproval({
                approvalRef: request.approvalRef,
                expectedVersion: request.version,
                action: "APPROVE",
                reason: "Cannot approve own evaluation",
                requestKey: key(),
              }),
            ),
            (e) => e.status === 403,
          );
          await assert.rejects(
            as("HR", () =>
              A.actApproval({
                approvalRef: request.approvalRef,
                expectedVersion: request.version + 1,
                action: "APPROVE",
                reason: "Stale request",
                requestKey: key(),
              }),
            ),
            (e) => e.status === 412,
          );
          const input = {
            approvalRef: request.approvalRef,
            expectedVersion: request.version,
            action: "APPROVE",
            reason: "Reviewed exact frozen revision",
            requestKey: key(),
          };
          const result = await as("HR", () => A.actApproval(input));
          assert.equal(result.record.stage, "APPROVED");
          assert.deepEqual(await as("HR", () => A.actApproval(input)), result);
          await assert.rejects(
            db((tx) =>
              tx.hrApprovalRequest.update({
                where: { id: request.approvalRef },
                data: { sourceHash: "forged" },
              }),
            ),
            /immutable/,
          );
          r = await db((tx) =>
            tx.perfReview.findFirst({ where: { id: r.id } }),
          );
          assert.equal(r.state, "CALIBRATION_READY");
        },
      );
      r = await as("CALIBRATOR", () =>
        S.transition({
          ...versioned(r),
          action: "PROPOSE_CALIBRATION",
          reason: "Reviewed the retained evidence against the anchor",
          adjustedScore: 80,
        }),
      );
      await t.test(
        "Calibration needs a second independent approver",
        async () => {
          await assert.rejects(
            as("CALIBRATOR", () =>
              S.transition({ ...versioned(r), action: "APPROVE_CALIBRATION" }),
            ),
            (e) => e.code === "INDEPENDENT_APPROVER_REQUIRED",
          );
        },
      );
      r = await as("HR", () =>
        S.transition({ ...versioned(r), action: "APPROVE_CALIBRATION" }),
      );
      await t.test(
        "Direct SQL release without signoff is rejected",
        async () => {
          await assert.rejects(
            db((tx) =>
              tx.perfReview.update({
                where: { id: r.id },
                data: { state: "RELEASED", version: { increment: 1 } },
              }),
            ),
            /Approval Centre approval required|signoff/,
          );
        },
      );
      await t.test(
        "Approval Centre release commits the published packet and decision atomically",
        async () => {
          const queue = await as("RELEASER", () =>
            A.listApprovals({ scope: "QUEUE", kind: "PERFORMANCE" }),
          );
          const request = queue.items.find(
            (x) =>
              x.sourceRef.startsWith("perf:RELEASE:") &&
              x.sourceRef.includes(r.id),
          );
          assert.ok(request);
          const result = await as("RELEASER", () =>
            A.actApproval({
              approvalRef: request.approvalRef,
              expectedVersion: request.version,
              action: "APPROVE",
              reason: "Release reviewed outcome",
              requestKey: key(),
            }),
          );
          assert.equal(result.record.execution, "APPLIED");
          r = await db((tx) =>
            tx.perfReview.findFirst({ where: { id: r.id } }),
          );
          assert.equal(r.state, "RELEASED");
          assert.equal(r.releasedRevisionId, r.currentRevisionId);
        },
      );
      await t.test("Released packet is reproducible and frozen", async () => {
        const detail = await as("EMPLOYEE", () => Q.get({ id: r.id }), [
          "hr.performance.read",
        ]);
        assert.equal(detail.revision.score.score, 80);
        assert.equal(
          detail.responses.some((x) => x.role === "MANAGER"),
          true,
        );
        await assert.rejects(
          db((tx) =>
            tx.perfReviewRevision.update({
              where: { id: detail.revision.id },
              data: { score: { score: 0 } },
            }),
          ),
          /immutable/,
        );
      });
      let decision = await as("MANAGER", () =>
        D.decisionCreate({
          requestKey: key(),
          reviewId: r.id,
          kind: "DEVELOPMENT",
          rationale: "Build the documented capability",
        }),
      );
      r = await as("EMPLOYEE", () =>
        S.appeal({
          ...versioned(r),
          action: "FILE",
          reason: "Please review the supporting evidence",
        }),
      );
      await t.test(
        "Open appeal blocks consequential approval in the transaction",
        async () => {
          await assert.rejects(
            as("HR", () =>
              D.decisionAction({
                ...versioned(decision),
                action: "APPROVE_HR",
                reason: "Reviewed",
              }),
            ),
            (e) => e.code === "APPEAL_HOLD",
          );
        },
      );
      await t.test("Prior reviewer cannot decide the appeal", async () => {
        await assert.rejects(
          as("RELEASER", () =>
            S.appeal({ ...versioned(r), action: "UPHOLD", reason: "Reviewed" }),
          ),
          (e) => e.code === "INDEPENDENT_APPROVER_REQUIRED",
        );
      });
      r = await as("APPEAL", () =>
        S.appeal({
          ...versioned(r),
          action: "UPHOLD",
          reason: "Independent review confirms the evidence and outcome",
        }),
      );
      r = await as("EMPLOYEE", () =>
        S.transition({ ...versioned(r), action: "ACKNOWLEDGE" }),
      );
      decision = await as("HR", () =>
        D.decisionAction({
          ...versioned(decision),
          action: "APPROVE_HR",
          reason: "Development plan reviewed",
        }),
      );
      decision = await as("BUDGET", () =>
        D.decisionAction({
          ...versioned(decision),
          action: "APPROVE_BUDGET",
          reason: "Budget reserved in the approved plan",
        }),
      );
      await t.test("Execution waits for appeal window expiry", async () => {
        await assert.rejects(
          as("EXECUTOR", () =>
            D.decisionAction({
              ...versioned(decision),
              action: "APPROVE_EXECUTION",
              reason: "Approved",
            }),
          ),
          (e) => e.code === "APPEAL_WINDOW_OPEN",
        );
      });
      await t.test(
        "Closing the cycle retains the right to acknowledge and appeal",
        async () => {
          // This employee already acknowledged; the release remains readable after closure.
          cycle = await as("HR", () =>
            S.cycleTransition({
              ...versioned(cycle),
              action: "CALIBRATE",
              reason: "Review work completed",
            }),
          );
          cycle = await as("HR", () =>
            S.cycleTransition({
              ...versioned(cycle),
              action: "CLOSE",
              reason: "Released roster reconciled",
            }),
          );
          const detail = await as("EMPLOYEE", () => Q.get({ id: r.id }));
          assert.ok(detail.revision);
        },
      );
      await t.test(
        "Appeal correction keeps the previous release visible through successor approval",
        async () => {
          const prior = await as("EMPLOYEE", () => Q.get({ id: r.id }));
          const releasedId = prior.revision.id;
          r = await as("EMPLOYEE", () =>
            S.appeal({
              ...versioned(r),
              action: "FILE",
              reason: "New supporting evidence for correction",
            }),
          );
          // A different independent decider is needed because the first decider signed the earlier appeal.
          r = await as("NEW_MANAGER", () =>
            S.appeal({
              ...versioned(r),
              action: "REVISE",
              reason: "Independent finding requires a successor revision",
            }),
          );
          assert.equal(r.state, "CORRECTION_OPEN");
          const correctionMetrics = await as("HR", () =>
            Q.analytics({ cycleId: cycle.id }),
          );
          assert.equal(correctionMetrics.released, 1);
          assert.equal(correctionMetrics.completionPercent, 100);
          assert.equal(correctionMetrics.correctionsInProgress, 1);
          assert.equal(correctionMetrics.originalOnTime, 1);
          assert.equal(correctionMetrics.distribution.suppressed, true);
          assert.deepEqual(correctionMetrics.distribution.bands, []);
          r = await as("MANAGER", () =>
            S.responseSave({
              ...versioned(r),
              role: "MANAGER",
              answers: [
                {
                  ...answers[0],
                  rating: 5,
                  narrative: "Corrected retained evidence",
                },
              ],
            }),
          );
          assert.equal(
            (await as("EMPLOYEE", () => Q.get({ id: r.id }))).revision.id,
            releasedId,
          );
          r = await as("MANAGER", () =>
            S.transition({ ...versioned(r), action: "SUBMIT_MANAGER" }),
          );
          assert.equal(
            (await as("EMPLOYEE", () => Q.get({ id: r.id }))).revision.id,
            releasedId,
          );
          r = await as("HR", () =>
            S.transition({ ...versioned(r), action: "APPROVE_SENIOR" }),
          );
          await assert.rejects(
            as("RELEASER", () =>
              S.transition({ ...versioned(r), action: "RELEASE" }),
            ),
            (e) => e.code === "STATE_CONFLICT",
          );
          r = await as("HR", () =>
            S.transition({
              ...versioned(r),
              action: "CONFIRM_CALIBRATION",
              reason: "No adjustment required against published anchors",
            }),
          );
          r = await as("RELEASER", () =>
            S.transition({ ...versioned(r), action: "RELEASE" }),
          );
          const current = await as("EMPLOYEE", () => Q.get({ id: r.id }));
          assert.notEqual(current.revision.id, releasedId);
          assert.equal(current.revision.score.score, 100);
          assert.equal(
            current.revision.content.managerResponse[0].narrative,
            "Corrected retained evidence",
          );
          r = await as("EMPLOYEE", () =>
            S.transition({ ...versioned(r), action: "ACKNOWLEDGE" }),
          );
          assert.equal(r.state, "ACKNOWLEDGED");
          const metrics = await as("HR", () =>
            Q.analytics({ cycleId: cycle.id }),
          );
          assert.equal(metrics.population, 1);
          assert.equal(metrics.completionPercent, 100);
          assert.equal(metrics.metricVersion, 2);
          assert.equal(metrics.originalOnTime, 1);
          assert.equal(metrics.selfSubmitted, 1);
          assert.equal(metrics.correctionsInProgress, 0);
          assert.equal(metrics.closingSnapshot.released, 1);
          assert.equal(metrics.closingSnapshot.metricVersion, 2);
          await assert.rejects(
            as("EMPLOYEE", () => Q.analytics({ cycleId: cycle.id }), [
              "hr.performance.read",
            ]),
            (e) => e.status === 403,
          );
        },
      );
      await t.test(
        "Aggregate export is scoped, auditable, replayable and reauthorises cached results",
        async () => {
          const input = { cycleId: cycle.id, requestKey: key() };
          const output = await as("HR", () => Q.analyticsExport(input));
          assert.equal(output.mediaType, "text/csv;charset=utf-8");
          assert.ok(output.content.includes('"health","released","1"'));
          assert.ok(
            output.content.includes('"distribution","suppressed","true"'),
          );
          assert.ok(!output.content.includes("Corrected retained evidence"));
          assert.ok(!output.content.includes(people.EMPLOYEE.employee_code));
          assert.deepEqual(
            await as("HR", () => Q.analyticsExport(input)),
            output,
          );
          assert.equal(
            await db((tx) =>
              tx.perfAudit.count({
                where: {
                  tenantId: tenant,
                  aggregateId: cycle.id,
                  operation: "ANALYTICS_EXPORT",
                },
              }),
            ),
            1,
          );
          await assert.rejects(
            as("HR", () => Q.analyticsExport(input), ["hr.performance.audit"]),
            (e) => e.status === 403,
          );
          await assert.rejects(
            as("HR", () =>
              Q.analyticsExport({
                ...input,
                requestKey: key(),
                cycleId: other,
              }),
            ),
            (e) => e.status === 404,
          );
        },
      );
      await t.test(
        "Every committed transition has audit and minimal outbox payload",
        async () => {
          const events = await db((tx) =>
            tx.outboxEvent.findMany({
              where: { tenantId: tenant, aggregateId: r.id },
            }),
          );
          assert.ok(events.length >= 7);
          assert.ok(
            (await db((tx) =>
              tx.perfAudit.count({ where: { aggregateId: r.id } }),
            )) >= 10,
          );
          for (const ev of events) {
            const payload = ev.payload?.payload || ev.payload;
            assert.ok(
              !JSON.stringify(payload).includes("Confidential manager draft"),
            );
          }
        },
      );
      await t.test(
        "Current reporting line revocation removes former manager access",
        async () => {
          await admin.query(
            'UPDATE "Employee" SET "managerId"=$1 WHERE id=$2',
            [people.NEW_MANAGER.id, people.EMPLOYEE.id],
          );
          await assert.rejects(
            as("MANAGER", () => Q.get({ id: r.id }), ["hr.performance.read"]),
            (e) => e.status === 404,
          );
        },
      );
    } finally {
      await runtime.end();
      await admin.end();
      await prisma.$disconnect();
    }
  },
);
