import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  !process.env.KUBERNETES_SERVICE_HOST ||
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use the isolated Kubernetes recruitment fixture");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_RECRUITMENT_JOB_BOARDS_ENABLED = "true";
process.env.HR_RECRUITMENT_PUBLIC_PORTAL = "true";
process.env.HR_RECRUITMENT_JOB_BOARD_SIGNING_KEY = Buffer.alloc(32, 83).toString("base64");
delete process.env.HR_RECRUITMENT_JOB_BOARDS;
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const settings = await import("../../src/services/recruitmentSettings.service.js");
const { jobBoardFeed } = await import("../../src/services/job-board-feeds.service.js");
const { boardReference } = await import("../../src/lib/job-board-feeds.js");
const { JobBoardSettings } = await import("@trusoft/contracts/recruitment-policy");
const tenantId = randomUUID(),
  other = randomUUID();
process.env.HR_PORTAL_HOSTS = "www." + tenantId + ".example.invalid=" + tenantId;
const config = JobBoardSettings.parse({
  companyName: "Fictional employer",
  sourceName: "Fictional group",
  publisher: "Fictional ATS",
  publisherUrl: "https://ats.example.invalid",
  careersOrigin: "https://www." + tenantId + ".example.invalid",
  locations: [{ name: "Karachi", city: "Karachi", state: "Sindh", country: "PK" }],
  INDEED: { enabled: true, accountEmail: "indeed@example.invalid" },
});
let employee, record, jobs;
const tx = (fn, t = tenantId) =>
  mcpCtx.run({ user: { tenantId: t } }, () => tenantTransaction(db, fn, { tenantId: t }));
const as = (
  fn,
  {
    roles = ["HR_ADMIN"],
    permissions = ["hr.recruitment.read", "hr.recruitment.update", "hr.recruitment.create"],
    tenant = tenantId,
  } = {},
) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId: tenant, userId: employee.userId, roles },
      permissions,
    },
    fn,
  );
const save = (board, extras = {}) =>
  as(() =>
    settings.recruitmentSettingsSet({
      policy: { ...record.policy, jobBoards: board },
      expectedVersion: record.version,
      reason: "Reviewed company provider configuration",
      reconcileJobBoards: true,
      ...extras,
    }),
  );
const feed = () =>
  mcpCtx.run({ user: { tenantId }, publicPortal: true }, () =>
    jobBoardFeed({ tenantId, channel: "INDEED" }),
  );
test("company job-board administration persists and activates atomically", async (t) => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenantId,
        employee_code: "BOARDSET-" + randomUUID().toUpperCase(),
        userId: randomInt(1000000, 2000000000),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
      },
    });
    jobs = [];
    for (let n = 0; n < 2; n++) {
      const job = await q.jobRequisition.create({
        data: {
          tenantId,
          title: "Public editor " + n,
          requestedById: employee.id,
          status: "POSTED",
          location: "Karachi",
          jobContent: {
            summary:
              "A complete public description of a fictional vacancy with responsibilities, requirements and benefits for applicants.",
          },
        },
      });
      jobs.push(job);
      await q.jobPosting.create({
        data: {
          tenantId,
          requisitionId: job.id,
          channel: "CAREER_SITE",
          isActive: true,
          postedById: employee.id,
        },
      });
    }
  });
  record = await as(() => settings.recruitmentSettingsGet());
  await t.test("recruiters cannot change company provider configuration", async () => {
    await assert.rejects(
      as(
        () =>
          settings.recruitmentSettingsSet({
            policy: { ...record.policy, jobBoards: config },
            expectedVersion: 0,
            reason: "Unauthorized provider configuration",
          }),
        { roles: ["RECRUITER"] },
      ),
      { status: 403 },
    );
  });
  await t.test("disabled drafts persist without creating channel postings", async () => {
    record = await save(JobBoardSettings.parse({ companyName: "Draft employer" }));
    assert.equal(record.version, 1);
    assert.equal(
      await tx((q) => q.jobPosting.count({ where: { tenantId, channel: "INDEED" } })),
      0,
    );
  });
  await t.test("foreign website binding is rejected with no version change", async () => {
    await assert.rejects(
      save({ ...config, careersOrigin: "https://www.foreign.example.invalid" }),
      { code: "HR-5314" },
    );
    assert.equal((await as(() => settings.recruitmentSettingsGet())).version, record.version);
  });
  await t.test("missing exact vacancy location prevents activation", async () => {
    await assert.rejects(
      save({ ...config, locations: [{ ...config.locations[0], name: "Lahore" }] }),
      { status: 409 },
    );
    assert.equal(
      await tx((q) => q.jobPosting.count({ where: { tenantId, channel: "INDEED" } })),
      0,
    );
  });
  await t.test("publication permission is needed to add existing Indeed inventory", async () => {
    await assert.rejects(
      as(
        () =>
          settings.recruitmentSettingsSet({
            policy: { ...record.policy, jobBoards: config },
            expectedVersion: record.version,
            reason: "Review with insufficient publication permission",
            reconcileJobBoards: true,
          }),
        { permissions: ["hr.recruitment.read", "hr.recruitment.update"] },
      ),
      { status: 403 },
    );
  });
  await t.test(
    "a later validation failure rolls back new postings and policy history",
    async () => {
      await assert.rejects(
        save(config, {
          policy: {
            ...record.policy,
            jobBoards: config,
            analyticsAlerts: {
              ...record.policy.analyticsAlerts,
              recipientEmployeeIds: [2147483000],
            },
          },
        }),
        { status: 422 },
      );
      assert.equal(
        await tx((q) => q.jobPosting.count({ where: { tenantId, channel: "INDEED" } })),
        0,
      );
      assert.equal(await tx((q) => q.recruitmentPolicyVersion.count({ where: { tenantId } })), 1);
    },
  );
  await t.test(
    "a hiring freeze blocks provider activation without changing policy or placements",
    async () => {
      const freeze = await tx((q) =>
        q.recruitmentHiringFreeze.create({
          data: {
            tenantId,
            scope: "COMPANY",
            reason: "Qualification hiring freeze",
            isActive: true,
            createdById: employee.id,
          },
        }),
      );
      try {
        await assert.rejects(save(config), { code: "HR-RECRUITMENT-HIRING-FREEZE" });
        assert.equal(
          await tx((q) => q.jobPosting.count({ where: { tenantId, channel: "INDEED" } })),
          0,
        );
        assert.equal((await as(() => settings.recruitmentSettingsGet())).version, record.version);
      } finally {
        await tx((q) =>
          q.recruitmentHiringFreeze.update({
            where: { id: freeze.id },
            data: {
              isActive: false,
              liftedAt: new Date(),
              liftedById: employee.id,
              liftReason: "End isolated qualification freeze",
            },
          }),
        );
      }
    },
  );
  await t.test(
    "enabling Indeed includes every eligible public vacancy and feeds saved identities",
    async () => {
      record = await save(config);
      const rows = await tx((q) =>
        q.jobPosting.findMany({ where: { tenantId, channel: "INDEED" } }),
      );
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every(
          (p) =>
            p.channelRef === boardReference(tenantId, p.requisitionId, "INDEED") &&
            p.postedById === employee.id,
        ),
      );
      const xml = await feed();
      assert.equal((xml.match(/<job>/g) || []).length, 2);
      assert.ok(xml.includes("indeed@example.invalid"));
    },
  );
  await t.test("concurrent administrators get one version and one stale-save refusal", async () => {
    const results = await Promise.allSettled([save(config), save(config)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.status, 412);
    record = results.find((r) => r.status === "fulfilled").value;
    assert.equal(
      await tx((q) => q.jobPosting.count({ where: { tenantId, channel: "INDEED" } })),
      2,
    );
  });
  await t.test("older policy editors preserve existing provider settings", async () => {
    const policy = { ...record.policy };
    delete policy.jobBoards;
    record = await as(() =>
      settings.recruitmentSettingsSet({
        policy,
        expectedVersion: record.version,
        reason: "Update through a legacy policy editor",
      }),
    );
    assert.equal(record.policy.jobBoards.INDEED.accountEmail, config.INDEED.accountEmail);
  });
  await t.test("other tenant cannot read or reuse the company configuration", async () => {
    const row = await tx((q) => q.recruitmentSettings.findUnique({ where: { tenantId } }), other);
    assert.equal(row, null);
  });
  await t.test(
    "disabling providers serves empty feeds while preserving the audit history",
    async () => {
      record = await save({ ...config, INDEED: { ...config.INDEED, enabled: false } });
      assert.equal((await feed()).includes("<job>"), false);
      const history = await tx((q) =>
        q.recruitmentPolicyVersion.findMany({ where: { tenantId }, orderBy: { version: "asc" } }),
      );
      assert.ok(history.some((p) => p.policy.jobBoards?.INDEED?.enabled));
      assert.equal(history.at(-1).changedById, employee.id);
    },
  );
  await t.test(
    "reactivating existing provider placements also respects a hiring freeze",
    async () => {
      const freeze = await tx((q) =>
        q.recruitmentHiringFreeze.create({
          data: {
            tenantId,
            scope: "COMPANY",
            reason: "Qualification reactivation freeze",
            isActive: true,
            createdById: employee.id,
          },
        }),
      );
      try {
        await assert.rejects(save(config), { code: "HR-RECRUITMENT-HIRING-FREEZE" });
        assert.equal((await feed()).includes("<job>"), false);
        assert.equal((await as(() => settings.recruitmentSettingsGet())).version, record.version);
      } finally {
        await tx((q) =>
          q.recruitmentHiringFreeze.update({
            where: { id: freeze.id },
            data: {
              isActive: false,
              liftedAt: new Date(),
              liftedById: employee.id,
              liftReason: "End isolated reactivation freeze",
            },
          }),
        );
      }
    },
  );
  await t.test(
    "policy events contain version references without provider account details",
    async () => {
      const events = await tx((q) =>
        q.outboxEvent.findMany({
          where: { tenantId, eventName: "hr.recruitment.policy_changed.v1" },
        }),
      );
      assert.ok(events.length > 0);
      assert.equal(JSON.stringify(events).includes("indeed@example.invalid"), false);
    },
  );
});
test.after(async () => {
  await db.$disconnect();
});
