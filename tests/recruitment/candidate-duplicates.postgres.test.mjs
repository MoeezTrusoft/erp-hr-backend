import test from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const {
  refreshCandidateDuplicates,
  listCandidateDuplicates,
  dismissCandidateDuplicate,
  runCandidateDuplicateDetection,
} = await import("../../src/services/candidateDuplicates.service.js");
const { registerRecruitmentExtraTools } =
  await import("../../src/mcp/tools/recruitmentExtraTools.js");
const tenant = randomUUID(),
  foreign = randomUUID(),
  handlers = {};
let employee, people;
registerRecruitmentExtraTools({
  tool: (name, _description, _schema, fn) => (handlers[name] = fn),
});
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, {
      tenantId: t,
      txOptions: { timeout: 30000, maxWait: 10000 },
    }),
  );
const as = (fn, role = "HR_ADMIN", extra = {}) =>
  mcpCtx.run(
    {
      actorVerified: role !== "UNVERIFIED",
      user: {
        tenantId: tenant,
        userId: employee.userId,
        employeeId: 999999999,
        roles: [role],
        isAdmin: true,
        ...extra,
      },
      permissions: ["hr.recruitment.read", "hr.recruitment.update"],
    },
    fn,
  );
const refresh = () =>
  as(() => refreshCandidateDuplicates({ tenantId: tenant }));
const list = (args = {}, role) =>
  as(() => listCandidateDuplicates({ tenantId: tenant, ...args }), role);
const dismiss = (
  row,
  reason = "Verified that these are different people.",
  version = row.version,
) =>
  as(() =>
    dismissCandidateDuplicate({
      tenantId: tenant,
      id: row.id,
      expectedVersion: version,
      reason,
    }),
  );
test.before(async () => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 1000000000),
        employee_code: randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        status: "Active",
        first_name: "Fictional",
      },
    });
    const parsedEmail = randomUUID() + "@example.invalid",
      caseEmail = randomUUID() + "@example.invalid";
    people = [];
    for (const data of [
      { phone: "+92 (300) 123-4567" },
      { phone: "923001234567" },
      { email: parsedEmail },
      { parsedResume: { contact: { email: parsedEmail } } },
      { email: caseEmail },
      { email: caseEmail.toUpperCase() },
      { phone: "123", parsedResume: { email: false, phone: { number: 123 } } },
    ])
      people.push(
        await q.candidate.create({
          data: {
            tenantId: tenant,
            firstName: "Fictional",
            lastName: "Person",
            email: randomUUID() + "@example.invalid",
            ...data,
          },
        }),
      );
  });
  await tx(
    (q) =>
      q.candidate.create({
        data: {
          tenantId: foreign,
          firstName: "Foreign",
          email: randomUUID() + "@example.invalid",
          phone: "923001234567",
        },
      }),
    foreign,
  );
});
test("profile and parsed contact matches are queued once with no automatic merge", async () => {
  const scans = await Promise.all([refresh(), refresh()]);
  assert.equal(
    scans.reduce((n, s) => n + s.created, 0),
    3,
  );
  assert.equal(
    scans.some((s) => s.more),
    false,
  );
  const second = await refresh();
  assert.equal(second.created + second.refreshed + second.resolved, 0);
  const rows = await list();
  assert.equal(rows.total, 3);
  assert.ok(rows.items.some((r) => r.reasons.includes("PHONE")));
  assert.ok(rows.items.every((r) => r.left.id < r.right.id));
  assert.equal(
    await tx((q) =>
      q.candidate.count({ where: { tenantId: tenant, status: "active" } }),
    ),
    7,
  );
  const events = await tx((q) =>
    q.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.recruitment.duplicate_suggestions_updated.v1",
      },
    }),
  );
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes("@example.invalid"));
});
test("dismissal uses current version, real actor and preserves reviewed rationale without reopening on unrelated edits", async () => {
  const row = (await list()).items.find((r) => r.reasons.includes("PHONE"));
  await assert.rejects(dismiss(row, "short"), (e) => e.status === 422);
  await assert.rejects(dismiss(row, undefined, 99), (e) => e.status === 412);
  const result = await dismiss(row);
  assert.equal(result.state, "DISMISSED");
  assert.equal(result.version, row.version + 1);
  await assert.rejects(dismiss(row), (e) => e.status === 412);
  await tx((q) =>
    q.candidate.update({
      where: { id: people[0].id },
      data: { notes: "Unrelated edit", version: { increment: 1 } },
    }),
  );
  await refresh();
  const dismissed = await list({ state: "DISMISSED" });
  assert.equal(dismissed.total, 1);
  assert.equal(
    dismissed.items[0].reviewReason,
    "Verified that these are different people.",
  );
  const stored = await tx(
    (q) =>
      q.$queryRaw`SELECT "reviewedById" FROM "CandidateDuplicateSuggestion" WHERE id=${row.id}::uuid`,
  );
  assert.equal(stored[0].reviewedById, employee.id);
});
test("new contact evidence reopens a dismissed pair and stale snapshots cannot be dismissed", async () => {
  const row = (await list({ state: "DISMISSED" })).items[0];
  await tx((q) =>
    q.candidate.update({
      where: { id: people[0].id },
      data: { parsedResume: { email: "new-evidence@example.invalid" } },
    }),
  );
  assert.equal((await list({ state: "DISMISSED" })).total, 0);
  await assert.rejects(dismiss(row), (e) => e.status === 412);
  const result = await refresh();
  assert.equal(result.refreshed, 1);
  const changed = (await list()).items.find((r) => r.id === row.id);
  assert.ok(changed.version > row.version);
  assert.equal(changed.reviewReason, null);
});
test("archiving/removing contact matches resolves queue entries and erasure removes all inferred links atomically", async () => {
  await tx((q) =>
    q.candidate.update({
      where: { id: people[0].id },
      data: { status: "archived", archivedAt: new Date() },
    }),
  );
  assert.equal((await list()).total, 2);
  assert.equal((await refresh()).resolved, 1);
  await tx((q) =>
    q.candidate.update({
      where: { id: people[2].id },
      data: { anonymizedAt: new Date() },
    }),
  );
  const erased = await tx(
    (q) =>
      q.$queryRaw`SELECT id FROM "CandidateDuplicateSuggestion" WHERE "tenantId"=${tenant}::uuid AND ("leftId"=${people[2].id} OR "rightId"=${people[2].id})`,
  );
  assert.equal(erased.length, 0);
  await tx((q) =>
    q.candidate.update({
      where: { id: people[5].id },
      data: { email: randomUUID() + "@example.invalid" },
    }),
  );
  assert.equal((await list()).total, 0);
  assert.equal((await refresh()).resolved, 1);
});
test("queue is tenant and role scoped; scheduler identity cannot be forged by a user", async () => {
  for (const role of [
    "HIRING_MANAGER",
    "INTERVIEWER",
    "FINANCE",
    "AGENCY",
    "UNVERIFIED",
  ])
    await assert.rejects(list({}, role), (e) => e.status === 403);
  await assert.rejects(list({ tenantId: foreign }), (e) => e.status === 403);
  await assert.rejects(
    as(() => refreshCandidateDuplicates({ tenantId: tenant }), "HR_ADMIN", {
      isAutomation: true,
    }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    as(() => runCandidateDuplicateDetection()),
    (e) => e.status === 403,
  );
  const rows = await tx(
    (q) =>
      q.$queryRaw`SELECT id FROM "CandidateDuplicateSuggestion" WHERE "tenantId"=${tenant}::uuid`,
    foreign,
  );
  assert.equal(rows.length, 0);
});
test("bounded scans continue beyond 200 pairs and queue pagination has no duplicate or missing rows", async () => {
  await tx((q) =>
    q.candidate.createMany({
      data: Array.from({ length: 22 }, (_, i) => ({
        tenantId: tenant,
        firstName: "Shared contact " + i,
        email: randomUUID() + "@example.invalid",
        phone: "+92 333 999 8765",
      })),
    }),
  );
  const a = await refresh(),
    b = await refresh();
  assert.equal(a.created, 200);
  assert.equal(a.more, true);
  assert.equal(b.created, 31);
  assert.equal(b.more, false);
  assert.equal((await refresh()).created, 0);
  const pages = await Promise.all(
    [1, 2, 3].map((page) => list({ page, pageSize: 100 })),
  );
  assert.equal(pages[0].total, 231);
  assert.equal(
    new Set(pages.flatMap((p) => p.items.map((r) => r.id))).size,
    231,
  );
});
test("MCP list and dismissal use typed review data and reject missing or foreign ids", async () => {
  const result = await as(() =>
    handlers.hr_candidate_duplicates_list({
      page: 2,
      pageSize: 100,
      state: "OPEN",
    }),
  );
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).items.length, 100);
  await assert.rejects(
    as(() =>
      dismissCandidateDuplicate({
        tenantId: tenant,
        id: randomUUID(),
        expectedVersion: 0,
        reason: "Different people confirmed.",
      }),
    ),
    (e) => e.status === 404,
  );
  for (const args of [{ page: 0 }, { pageSize: 101 }, { state: "RESOLVED" }])
    await assert.rejects(list(args), (e) => e.status === 422);
});
test("outbox failure rolls back dismissal and its audit receipt", async () => {
  const { Client } = await import("pg");
  const adminUrl = new URL(process.env.ASSESSMENT_TEST_ADMIN_URL || "http://invalid");
  if (adminUrl.hostname !== url.hostname || adminUrl.port !== url.port ||
      adminUrl.pathname !== url.pathname || adminUrl.username !== "postgres" || !adminUrl.password)
    throw new Error("Explicit isolated fixture owner connection required");
  const owner = new Client({ connectionString: adminUrl.href });
  await owner.connect();
  const fn = "duplicate_audit_" + randomUUID().replaceAll("-", "");
  const row = (await list()).items[0],
    before = await tx((q) =>
      q.log.count({
        where: { tenantId: tenant, module: "Candidate Duplicate" },
      }),
    );
  try {
    await owner.query(
      "CREATE FUNCTION " +
        fn +
        '() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId" = ' +
        "'" +
        tenant +
        "'" +
        '::uuid AND NEW."eventName" = ' +
        "'hr.recruitment.duplicate_suggestions_updated.v1'" +
        " THEN RAISE EXCEPTION " +
        "'Synthetic duplicate audit failure'" +
        "; END IF; RETURN NEW; END $$",
    );
    await owner.query(
      "CREATE TRIGGER " +
        fn +
        " BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION " +
        fn +
        "()",
    );
    await assert.rejects(dismiss(row), /Synthetic duplicate audit failure/);
    const current = (await list()).items.find((r) => r.id === row.id);
    assert.equal(current.version, row.version);
    assert.equal(current.state, "OPEN");
    assert.equal(
      await tx((q) =>
        q.log.count({
          where: { tenantId: tenant, module: "Candidate Duplicate" },
        }),
      ),
      before,
    );
  } finally {
    await owner.query("DROP TRIGGER IF EXISTS " + fn + " ON outbox_events");
    await owner.query("DROP FUNCTION IF EXISTS " + fn + "()");
    await owner.end();
  }
});
test("concurrent erasure and detection cannot recreate an inferred identity link", async () => {
  const pair = await tx(async (q) => {
    const out = [];
    for (let i = 0; i < 2; i++)
      out.push(
        await q.candidate.create({
          data: {
            tenantId: tenant,
            firstName: "Erase race",
            email: randomUUID() + "@example.invalid",
            phone: "+92 311 987 1234",
          },
        }),
      );
    return out;
  });
  await Promise.all([
    refresh(),
    tx((q) =>
      q.candidate.update({
        where: { id: pair[0].id },
        data: { anonymizedAt: new Date() },
      }),
    ),
  ]);
  const rows = await tx((q) =>
    q.$queryRawUnsafe(
      'SELECT id FROM "CandidateDuplicateSuggestion" WHERE "tenantId"=$1::uuid AND ("leftId"=$2 OR "rightId"=$2)',
      tenant,
      pair[0].id,
    ),
  );
  assert.equal(rows.length, 0);
});
test.after(async () => {
  for (const t of [tenant, foreign])
    await tx(async (q) => {
      await q.$executeRaw`DELETE FROM "CandidateDuplicateSuggestion" WHERE "tenantId"=${t}::uuid`;
      await q.outboxEvent.deleteMany({ where: { tenantId: t } });
      await q.log.deleteMany({ where: { tenantId: t } });
      await q.candidate.deleteMany({ where: { tenantId: t } });
      await q.employee.deleteMany({ where: { tenant_id: t } });
    }, t);
  await db.$disconnect();
});
