import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.HR_RECRUITMENT_CANONICAL_ANALYTICS = "on";
process.env.HR_RECRUITMENT_STAGE_SLA_DAYS = '{"interview":3}';
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const {
  computeRecruitmentAnalytics: report,
  drillDownRecruitmentMetric: drill,
} = await import("../../src/services/recruitmentAnalytics.service.js");
const { setCostConfig, getCostConfig } =
  await import("../../src/services/recruitmentCost.service.js");
const { registerRecruitmentAnalyticsTools } =
  await import("../../src/mcp/tools/recruitmentAnalyticsTools.js");
const tools = new Map();
registerRecruitmentAnalyticsTools({
  tool: (n, ...a) => tools.set(n, a.at(-1)),
});
const tenant = randomUUID(),
  foreign = randomUUID(),
  people = {},
  reqs = [],
  apps = [];
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, { tenantId: t }),
  );
const context = (
  role = "HR_ADMIN",
  name = "hr",
  permissions = [
    "hr.recruitment.read",
    "hr.recruitment.update",
    "hr.recruitment.export",
  ],
) => ({
  actorVerified: true,
  user: {
    tenantId: tenant,
    userId: people[name].userId,
    employeeId: people.hr.id,
    roles: [role],
  },
  permissions,
});
const as = (fn, role, name, permissions) =>
  mcpCtx.run(context(role, name, permissions), fn);
test.before(async () => {
  await tx(async (t) => {
    for (const name of ["hr", "manager", "other", "interviewer"])
      people[name] = await t.employee.create({
        data: {
          tenant_id: tenant,
          employee_code: "AN-" + randomUUID().toUpperCase(),
          userId: randomInt(10000, 1000000000),
          employeeCategory: "EMPLOYEE",
          first_name: name,
          status: "Active",
          employement_status: "Active",
        },
      });
    for (const [index, owner] of ["manager", "other"].entries()) {
      const req = await t.jobRequisition.create({
        data: {
          tenantId: tenant,
          title: "Analytics role " + index,
          requestedById: people[owner].id,
          recruiterId: people.hr.id,
          openings: 1,
          status: "POSTED",
        },
      });
      reqs.push(req);
      await t.requisitionTransition.create({
        data: {
          tenantId: tenant,
          requisitionId: req.id,
          fromStatus: "PENDING_APPROVAL",
          toStatus: "APPROVED",
          createdAt: new Date("2026-01-01"),
        },
      });
      for (const [j, source] of ["Referral", "Agency"].entries()) {
        const c = await t.candidate.create({
          data: {
            tenantId: tenant,
            firstName: "Fictional",
            email: randomUUID() + "@example.invalid",
            source,
          },
        });
        const a = await t.application.create({
          data: {
            tenantId: tenant,
            jobRequisitionId: req.id,
            candidateId: c.id,
            stage: j === 0 ? "hired" : "interview",
            appliedAt: new Date("2026-01-02"),
          },
        });
        apps.push(a);
        const offer = await t.offer.create({
          data: {
            tenantId: tenant,
            applicationId: a.id,
            candidateId: c.id,
            jobRequisitionId: req.id,
            salary: 1,
            currency: "USD",
            status: j === 0 ? "ACCEPTED" : "DRAFT",
            respondedAt: j === 0 ? new Date("2026-01-12") : null,
            sentAt: new Date("2026-01-10"),
            startDate: new Date("2026-01-22"),
          },
        });
        if (j === 1) {
          await t.hrApprovalRequest.create({
            data: {
              tenantId: tenant,
              kind: "OFFER",
              sourceRef: String(offer.id),
              employeeCode: people.hr.employee_code,
              stage: "APPROVED",
              sourceHash: "analytics-fixture",
              snapshot: {},
            },
          });
          await t.$executeRawUnsafe(
            "SELECT set_config('app.hr_approval_finalizing',$1,true)",
            "OFFER:" + offer.id,
          );
          await t.offer.update({
            where: { id: offer.id },
            data: { status: "SENT" },
          });
        }
      }
    }
  });
  await tx(async (t) => {
    const p = await t.employee.create({
      data: {
        tenant_id: foreign,
        employee_code: "AN-" + randomUUID().toUpperCase(),
        userId: randomInt(10000, 1000000000),
        employeeCategory: "EMPLOYEE",
        first_name: "Foreign",
      },
    });
    const r = await t.jobRequisition.create({
      data: { tenantId: foreign, title: "Foreign secret", requestedById: p.id },
    });
    const c = await t.candidate.create({
      data: {
        tenantId: foreign,
        firstName: "Foreign secret",
        email: randomUUID() + "@example.invalid",
      },
    });
    await t.application.create({
      data: {
        tenantId: foreign,
        jobRequisitionId: r.id,
        candidateId: c.id,
        stage: "hired",
      },
    });
  }, foreign);
});
test("real PostgreSQL metrics exclude foreign company and agree with evidence", async () => {
  const r = await as(() => report(tenant));
  assert.equal(r.totalHires, 2);
  assert.equal(r.canonicalMetrics.timeToHire.meanTimeToHireDays, 10);
  assert.equal(r.canonicalMetrics.timeToFill.meanTimeToFillDays, 11);
  assert.equal(r.canonicalMetrics.timeToStart.meanTimeToStartDays, 10);
  assert.equal(r.canonicalMetrics.offerAcceptance.acceptanceRatePct, 100);
  assert.equal(r.canonicalMetrics.offerAcceptance.pending, 2);
  const d = await as(() => drill(tenant, "timeToHireDays"));
  assert.equal(d.total, 2);
  assert.ok(d.rows.every((a) => a.timeToHireDays === 10));
});
test("attendance-confirmed starts require a completed handoff and settled company attendance", async () => {
  const before = await as(() => report(tenant));
  assert.equal(
    before.canonicalMetrics.attendanceConfirmedTimeToStart.startsMeasured,
    0,
  );
  await tx(async (t) => {
    const o = await t.offer.findFirst({
      where: { tenantId: tenant, applicationId: apps[0].id },
    });
    await t.offerHandoff.create({
      data: {
        tenantId: tenant,
        offerId: o.id,
        status: "COMPLETED",
        employeeId: people.manager.id,
        completedAt: new Date("2026-01-12"),
      },
    });
    const marks = [
      {
        date: "2026-01-11",
        status: "PRESENT",
        processingState: "FINALIZED",
        credit: 1,
      },
      {
        date: "2026-01-21",
        status: "PRESENT",
        processingState: "FINALIZED",
        credit: 1,
      },
      {
        date: "2026-01-22",
        status: "ON_LEAVE",
        processingState: "FINALIZED",
        credit: 1,
      },
      {
        date: "2026-01-23",
        status: "PRESENT",
        processingState: "NEEDS_REVIEW",
        credit: 1,
      },
      {
        date: "2026-01-24",
        status: "MISSING_CHECKOUT",
        processingState: "FINALIZED",
        credit: 1,
      },
      {
        date: "2026-01-25",
        status: "PRESENT",
        processingState: "FINALIZED",
        credit: 0,
      },
      {
        date: "2026-01-26",
        status: "LATE",
        processingState: "FINALIZED",
        credit: 0.5,
      },
      {
        date: "2026-01-27",
        status: "PRESENT",
        processingState: "FINALIZED",
        credit: 1,
      },
      {
        date: "2099-01-01",
        status: "PRESENT",
        processingState: "FINALIZED",
        credit: 1,
      },
    ];
    for (const m of marks)
      await t.attendance.create({
        data: {
          tenantId: tenant,
          employeeId: people.manager.id,
          date: new Date(m.date),
          check_in: new Date(m.date + "T00:00:00Z"),
          status: m.status,
          processingState: m.processingState,
          day_credit: m.credit,
          finalizedAt: new Date(m.date),
          requires_regularization: false,
        },
      });
  });
  const r = await as(() => report(tenant));
  assert.equal(
    r.canonicalMetrics.attendanceConfirmedTimeToStart.startsMeasured,
    1,
  );
  assert.equal(
    r.canonicalMetrics.attendanceConfirmedTimeToStart.meanTimeToStartDays,
    14,
  );
  const d = await as(() => drill(tenant, "confirmedTimeToStartDays"));
  assert.equal(d.total, 1);
  assert.equal(d.rows[0].applicationId, apps[0].id);
  assert.equal(
    d.rows[0].actualStartAt.toISOString(),
    "2026-01-26T00:00:00.000Z",
  );
  assert.ok(d.rows[0].attendanceId);
  assert.equal(
    (await as(() => report(tenant, { requisitionIds: [reqs[1].id] })))
      .canonicalMetrics.attendanceConfirmedTimeToStart.startsMeasured,
    0,
  );
  assert.equal(
    (await as(() => report(tenant), "HIRING_MANAGER", "other")).canonicalMetrics
      .attendanceConfirmedTimeToStart.startsMeasured,
    0,
  );
  await tx((t) =>
    t.attendance.updateMany({
      where: { tenantId: tenant, date: new Date("2026-01-26") },
      data: { requires_regularization: true },
    }),
  );
  assert.equal(
    (await as(() => report(tenant))).canonicalMetrics
      .attendanceConfirmedTimeToStart.meanTimeToStartDays,
    15,
  );
  await tx((t) =>
    t.offerHandoff.updateMany({
      where: { tenantId: tenant },
      data: { status: "FAILED" },
    }),
  );
  assert.equal(
    (await as(() => report(tenant))).canonicalMetrics
      .attendanceConfirmedTimeToStart.startsMeasured,
    0,
  );
});
test("a manager sees only owned requisitions despite a forged employee claim", async () => {
  const r = await as(() => report(tenant), "HIRING_MANAGER", "manager");
  assert.equal(r.totalHires, 1);
  assert.equal(r.canonicalMetrics.timeToFill.perRequisition.length, 1);
  assert.equal(
    r.canonicalMetrics.timeToFill.perRequisition[0].requisitionId,
    reqs[0].id,
  );
  assert.equal(r.costPerHire.reason, "scope-not-allocated");
});
test("interviewers, unknown roles and unverified users cannot obtain reporting cohorts", async () => {
  for (const role of ["INTERVIEWER", "EMPLOYEE", "FINANCE"])
    await assert.rejects(
      as(() => report(tenant), role, "interviewer"),
      (e) => e.status === 403,
    );
  const c = context();
  c.actorVerified = false;
  await assert.rejects(
    mcpCtx.run(c, () => report(tenant)),
    (e) => e.status === 401,
  );
  await assert.rejects(
    as(() => report(foreign)),
    (e) => e.status === 401,
  );
});
test("all filters narrow metrics, requisitions and evidence in PostgreSQL", async () => {
  const f = {
    requisitionIds: [reqs[0].id],
    source: "Agency",
    stage: "interview",
    dateFrom: "2026-01-01",
    dateTo: "2026-01-03",
  };
  const r = await as(() => report(tenant, f)),
    d = await as(() => drill(tenant, "source:Agency", f));
  assert.equal(r.totalHires, 0);
  assert.equal(d.total, 1);
  assert.equal(d.rows[0].applicationId, apps[1].id);
  assert.equal(r.canonicalMetrics.timeToFill.meanTimeToFillDays, null);
  assert.deepEqual(r.filters, d.filters);
});
test("a manager cannot widen scope with another requisition filter", async () => {
  const r = await as(
    () => report(tenant, { requisitionIds: [reqs[1].id] }),
    "HIRING_MANAGER",
    "manager",
  );
  assert.equal(r.totalHires, 0);
  assert.equal(r.canonicalMetrics.timeToFill.perRequisition.length, 0);
});
test("no unconfigured illustrative costs, validated decimal inputs and concurrent updates", async () => {
  assert.equal(
    (await as(() => report(tenant))).costPerHire.reason,
    "not-configured",
  );
  for (const args of [{ jobAds: -1 }, { tools: NaN }, { currency: "bad" }])
    await assert.rejects(
      as(() => setCostConfig(tenant, args)),
      (e) => e.status === 422,
    );
  await as(() => setCostConfig(tenant, { jobAds: 100.25, currency: "USD" }));
  await Promise.all([
    as(() => setCostConfig(tenant, { agencyFees: 20.5 })),
    as(() => setCostConfig(tenant, { tools: 10.25 })),
  ]);
  const c = await as(() => getCostConfig(tenant));
  assert.equal(Number(c.agencyFees), 20.5);
  assert.equal(Number(c.tools), 10.25);
  const r = await as(() => report(tenant));
  assert.equal(r.costPerHire.value, 65.5);
  assert.equal(r.costPerHire.currency, "USD");
  assert.equal(
    (await as(() => report(tenant, { source: "Referral" }))).costPerHire.reason,
    "filters-not-allocated",
  );
});
test("manager cannot edit company cost inputs or impersonate HR role with grants", async () => {
  await assert.rejects(
    as(() => setCostConfig(tenant, { jobAds: 0 }), "HIRING_MANAGER", "manager"),
    (e) => e.status === 403,
  );
  await assert.rejects(
    as(() => getCostConfig(tenant), "INTERVIEWER", "interviewer"),
    (e) => e.status === 403,
  );
});
test("SLA and workload evidence excludes terminal applications", async () => {
  const r = await as(() => report(tenant));
  assert.equal(r.canonicalMetrics.slaAging.openApplications, 2);
  assert.equal(r.canonicalMetrics.slaAging.breached, 2);
  assert.equal(r.canonicalMetrics.recruiterWorkload[0].activeApplications, 2);
  const d = await as(() => drill(tenant, "slaAging"));
  assert.equal(d.total, 2);
  assert.ok(d.rows.every((a) => a.stage === "interview"));
});
test("export requires export grant and preserves filters and canonical version", async () => {
  const denied = await as(
    () => tools.get("hr_recruitment_analytics_export")({ format: "csv" }),
    "HR_ADMIN",
    "hr",
    ["hr.recruitment.read"],
  );
  assert.equal(denied.isError, true);
  const f = { source: "Referral" };
  const result = await as(() =>
    tools.get("hr_recruitment_analytics_export")({ format: "csv", ...f }),
  );
  assert.ok(!result.isError, JSON.stringify(result));
  const data = JSON.parse(result.content[0].text);
  assert.deepEqual(data.filters, f);
  assert.equal(data.metricsVersion, 1);
  const csv = Buffer.from(data.base64, "base64").toString();
  assert.ok(csv.includes("Referral"));
  assert.ok(!csv.includes("Agency"));
});
test("company thresholds drive canonical SLA and deduplicated scheduler inbox alerts", async () => {
  const { recruitmentSettingsSet } =
    await import("../../src/services/recruitmentSettings.service.js");
  const { runRecruitmentAnalyticsAlerts } =
    await import("../../src/services/recruitmentAnalyticsAlerts.service.js");
  const { computeRecruitmentAnalyticsForScheduler } =
    await import("../../src/services/recruitmentAnalytics.service.js");
  const policy = {
    stageSlaDays: { interview: 1 },
    analyticsAlerts: {
      enabled: true,
      lookbackDays: 90,
      minimumSample: 1,
      cooldownHours: 24,
      maxTimeToFillDays: 10,
      maxFailedHandoffs: 0,
      recipientEmployeeIds: [people.hr.id],
    },
  };
  await assert.rejects(
    as(() =>
      recruitmentSettingsSet({
        policy: {
          ...policy,
          analyticsAlerts: {
            ...policy.analyticsAlerts,
            recipientEmployeeIds: [2147483647],
          },
        },
        expectedVersion: 0,
        reason: "Set tenant alert policy",
      }),
    ),
    (e) => e.status === 422,
  );
  await as(() =>
    recruitmentSettingsSet({
      policy,
      expectedVersion: 0,
      reason: "Set tenant alert policy",
    }),
  );
  assert.equal(
    (await as(() => report(tenant))).canonicalMetrics.slaAging.byStage.interview
      .breached,
    2,
  );
  const now = new Date("2026-02-01T12:00:00Z");
  const run = () =>
    mcpCtx.run({ system: true }, () =>
      runRecruitmentAnalyticsAlerts({ tenantId: tenant, now }),
    );
  const results = await Promise.all([run(), run()]);
  assert.equal(
    results.reduce((n, r) => n + r.failed, 0),
    0,
  );
  assert.equal(
    results.reduce((n, r) => n + r.enqueued, 0),
    3,
    JSON.stringify(results),
  );
  const events = await tx((t) =>
    t.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.recruitment.analytics_threshold_breached.v1",
      },
    }),
  );
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.payload.payload.kind).sort(), [
    "FAILED_HANDOFFS",
    "STAGE_SLA_BREACHES",
    "TIME_TO_FILL",
  ]);
  assert.ok(events.every((e) => e.payload.payload.dateTo === "2026-01-31"));
  assert.equal((await run()).enqueued, 0);
  const failed = await as(() => drill(tenant, "failedHandoffs"));
  assert.equal(failed.total, 1);
  assert.equal(failed.rows[0].applicationId, apps[0].id);
  assert.equal(failed.rows[0].handoffStatus, "FAILED");
  assert.ok(!("lastError" in failed.rows[0]));
  assert.equal(
    (await as(() => drill(tenant, "failedHandoffs"), "HIRING_MANAGER", "other"))
      .total,
    0,
  );
  await tx((t) =>
    t.offerHandoff.updateMany({
      where: { tenantId: tenant },
      data: { status: "COMPLETED" },
    }),
  );
  assert.equal(
    (await as(() => report(tenant))).canonicalMetrics.handoffs.failed,
    0,
  );
  await assert.rejects(
    as(() => computeRecruitmentAnalyticsForScheduler(tenant)),
    (e) => e.status === 403,
  );
  await assert.rejects(
    as(() => runRecruitmentAnalyticsAlerts({ tenantId: tenant })),
    (e) => e.status === 403,
  );
  const changed = {
    ...policy,
    analyticsAlerts: { ...policy.analyticsAlerts, enabled: false },
  };
  await as(() =>
    recruitmentSettingsSet({
      policy: changed,
      expectedVersion: 1,
      reason: "Pause company alert policy",
    }),
  );
  assert.equal((await run()).scanned, 0);
});
test.after(async () => {
  for (const t of [tenant, foreign])
    await tx(async (x) => {
      await x.recruitmentSettings.deleteMany({ where: { tenantId: t } });
      // Policy history is immutable. Retain its synthetic tenant and author fixture.
      await x.outboxEvent.deleteMany({ where: { tenantId: t } });
      await x.log.deleteMany({ where: { tenantId: t } });
      await x.hrApprovalRequest.deleteMany({ where: { tenantId: t } });
      await x.attendance.deleteMany({ where: { tenantId: t } });
      await x.offerHandoff.deleteMany({ where: { tenantId: t } });
      await x.offer.deleteMany({ where: { tenantId: t } });
      await x.application.deleteMany({ where: { tenantId: t } });
      await x.candidate.deleteMany({ where: { tenantId: t } });
      await x.requisitionTransition.deleteMany({ where: { tenantId: t } });
      await x.jobRequisition.deleteMany({ where: { tenantId: t } });
      await x.recruitmentCostConfig.deleteMany({ where: { tenantId: t } });
      if (t === foreign)
        await x.employee.deleteMany({ where: { tenant_id: t } });
    }, t);
  await db.$disconnect();
});
