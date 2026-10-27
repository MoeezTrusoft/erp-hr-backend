import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  !["5432", "55471"].includes(url.port) ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.HR_RECRUITMENT_CALENDAR_SYNC = "on";
const { default: db } = await import("../../src/lib/prisma.js");
const { runWithRequestContext } =
  await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { runInterviewCalendarSync: sync } =
  await import("../../src/services/interviewCalendarSync.service.js");
const scoped = (tenantId, fn) =>
  runWithRequestContext({ user: { tenantId } }, () =>
    tenantTransaction(db, fn, { tenantId }),
  );
const now = () => new Date(Date.now() + 3000);
const receipt = (intent, eventId = randomUUID()) => ({
  interviewId: intent.interviewId,
  revision: intent.revision,
  state: intent.state,
  provider: "communication-meetings",
  eventId,
});
const run = (f, send, at = now()) =>
  runWithRequestContext({ system: true }, () =>
    sync({ tenantId: f.tenantId, send, now: at }),
  );
async function fixture(userId = randomInt(100000, 999999999)) {
  const tenantId = randomUUID();
  const out = await scoped(tenantId, async (t) => {
    const employee = await t.employee.create({
      data: {
        tenant_id: tenantId,
        employee_code: randomUUID().toUpperCase(),
        userId,
        employeeCategory: "EMPLOYEE",
        status: "Active",
        employement_status: "Active",
        first_name: "Calendar fixture",
      },
    });
    const req = await t.jobRequisition.create({
      data: { tenantId, title: "Calendar fixture", requestedById: employee.id },
    });
    const candidate = await t.candidate.create({
      data: {
        tenantId,
        firstName: "Private name",
        email: randomUUID() + "@example.invalid",
        consentStatus: "GRANTED",
      },
    });
    const application = await t.application.create({
      data: { tenantId, candidateId: candidate.id, jobRequisitionId: req.id },
    });
    const interview = await t.interview.create({
      data: {
        tenantId,
        applicationId: application.id,
        interviewType: "ONSITE",
        scheduledAt: new Date("2030-01-07T04:00:00Z"),
        durationMinutes: 45,
        interviewers: { create: { tenantId, employeeId: employee.id } },
      },
    });
    return { employee, candidate, application, interview };
  });
  return { tenantId, ...out };
}
async function job(f) {
  return scoped(
    f.tenantId,
    async (t) =>
      (
        await t.$queryRawUnsafe(
          'SELECT * FROM interview_calendar_jobs WHERE "tenantId"=$1::uuid AND "interviewId"=$2',
          f.tenantId,
          f.interview.id,
        )
      )[0],
  );
}

test("calendar queue commits atomically and sends RBAC user identities with actual duration", async () => {
  const f = await fixture();
  const before = await job(f);
  await assert.rejects(
    scoped(f.tenantId, async (t) => {
      await t.interview.update({
        where: { id: f.interview.id },
        data: { durationMinutes: 75 },
      });
      throw Error("Rollback");
    }),
    /Rollback/,
  );
  assert.equal((await job(f)).revision, before.revision);
  let sent;
  assert.deepEqual(
    await run(f, async ({ tenantId, intent }) => {
      assert.equal(tenantId, f.tenantId);
      sent = intent;
      return receipt(intent);
    }),
    { synced: 1, retried: 0, superseded: 0 },
  );
  assert.equal(sent.durationMinutes, 45);
  assert.equal(sent.scheduledAt, "2030-01-07T04:00:00.000Z");
  assert.deepEqual(sent.panelUserIds, [String(f.employee.userId)]);
  assert.notEqual(f.employee.id, f.employee.userId);
  assert.equal(JSON.stringify(sent).includes(f.candidate.email), false);
  assert.equal((await job(f)).state, "SYNCED");
  assert.equal(
    (
      await scoped(f.tenantId, (t) =>
        t.interview.findUnique({ where: { id: f.interview.id } }),
      )
    ).calendarSyncStatus,
    "SYNCED",
  );
});
test("provider outage retains a frozen revision and retries without exposing remote errors", async () => {
  const f = await fixture();
  const first = now();
  let payload;
  assert.equal(
    (
      await run(
        f,
        async ({ intent }) => {
          payload = intent;
          throw Error("Password=do-not-store");
        },
        first,
      )
    ).retried,
    1,
  );
  assert.equal((await job(f)).lastError, "HR-5906");
  let calls = 0;
  await run(
    f,
    async () => {
      calls++;
    },
    first,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await run(
        f,
        async ({ intent }) => {
          assert.deepEqual(intent, payload);
          return receipt(intent);
        },
        new Date(first.getTime() + 120000),
      )
    ).synced,
    1,
  );
});
test("a late acknowledgement cannot overwrite a reschedule", async () => {
  const f = await fixture();
  let firstRevision;
  const result = await run(f, async ({ intent }) => {
    firstRevision = intent.revision;
    await scoped(f.tenantId, (t) =>
      t.interview.update({
        where: { id: f.interview.id },
        data: { durationMinutes: 90 },
      }),
    );
    return receipt(intent);
  });
  assert.equal(result.superseded, 1);
  assert.equal((await job(f)).state, "PENDING");
  assert.equal(
    (
      await run(f, async ({ intent }) => {
        assert.ok(intent.revision > firstRevision);
        assert.equal(intent.durationMinutes, 90);
        return receipt(intent);
      })
    ).synced,
    1,
  );
});
test("concurrent workers lease one outbound operation", async () => {
  const f = await fixture();
  let release, entered;
  const held = new Promise((r) => (release = r));
  const started = new Promise((r) => (entered = r));
  let calls = 0;
  const first = run(f, async ({ intent }) => {
    calls++;
    entered();
    await held;
    return receipt(intent);
  });
  await started;
  const second = await run(f, async ({ intent }) => {
    calls++;
    return receipt(intent);
  });
  release();
  assert.equal((await first).synced + second.synced, 1);
  assert.equal(calls, 1);
});
test("privacy withdrawal supersedes an in-flight write and cancellation runs with the flag off", async () => {
  const f = await fixture();
  const result = await run(f, async ({ intent }) => {
    await scoped(f.tenantId, (t) =>
      t.candidate.update({
        where: { id: f.candidate.id },
        data: { consentStatus: "WITHDRAWN" },
      }),
    );
    return receipt(intent);
  });
  assert.equal(result.superseded, 1);
  assert.equal((await job(f)).action, "CANCEL");
  await scoped(f.tenantId, t => t.interview.update({ where: { id: f.interview.id }, data: { durationMinutes: 30 } }));
  assert.equal((await job(f)).action, "CANCEL");
  process.env.HR_RECRUITMENT_CALENDAR_SYNC = "off";
  try {
    assert.equal(
      (
        await run(f, async ({ intent }) => {
          assert.equal(intent.state, "CANCELLED");
          assert.equal(intent.panelUserIds, undefined);
          return receipt(intent, null);
        })
      ).synced,
      1,
    );
  } finally {
    process.env.HR_RECRUITMENT_CALENDAR_SYNC = "on";
  }
});
test("source deletion retains a durable cancellation tombstone", async () => {
  const f = await fixture();
  await run(f, async ({ intent }) => receipt(intent));
  await scoped(f.tenantId, (t) =>
    t.interview.delete({ where: { id: f.interview.id } }),
  );
  assert.equal((await job(f)).action, "CANCEL");
  assert.ok((await job(f)).legacyEventId);
  assert.equal((await job(f)).legacyProvider, "communication-meetings");
  assert.equal((await run(f, async ({ intent }) => receipt(intent))).synced, 1);
});
test("application withdrawal cancels outstanding calendar work", async () => {
  const f = await fixture();
  await scoped(f.tenantId, (t) =>
    t.application.update({
      where: { id: f.application.id },
      data: { stage: "withdrawn" },
    }),
  );
  assert.equal((await job(f)).action, "CANCEL");
  await run(f, async ({ intent }) => {
    assert.equal(intent.state, "CANCELLED");
    return receipt(intent, null);
  });
});
test("missing panel account fails closed and identity correction queues a new revision", async () => {
  const f = await fixture(null);
  let calls = 0;
  const old = await job(f);
  assert.equal(
    (
      await run(f, async () => {
        calls++;
      })
    ).retried,
    1,
  );
  assert.equal(calls, 0);
  assert.equal((await job(f)).lastError, "HR-5905");
  await scoped(f.tenantId, (t) =>
    t.employee.update({
      where: { id: f.employee.id },
      data: { userId: randomInt(100000, 999999999) },
    }),
  );
  assert.ok((await job(f)).revision > old.revision);
  assert.equal((await run(f, async ({ intent }) => receipt(intent))).synced, 1);
});
test("unmatched receipt is retried, job rows enforce company RLS and only a scheduler can drain them", async () => {
  const f = await fixture();
  assert.equal(
    (
      await run(f, async ({ intent }) => ({
        ...receipt(intent),
        revision: intent.revision + 1,
      }))
    ).retried,
    1,
  );
  const foreign = randomUUID();
  assert.equal(
    (
      await scoped(foreign, (t) =>
        t.$queryRawUnsafe(
          'SELECT * FROM interview_calendar_jobs WHERE "interviewId"=$1',
          f.interview.id,
        ),
      )
    ).length,
    0,
  );
  await assert.rejects(
    scoped(foreign, (t) =>
      t.$executeRawUnsafe(
        'INSERT INTO interview_calendar_jobs ("tenantId","interviewId",action) VALUES ($1::uuid,$2,\'CANCEL\')',
        f.tenantId,
        2147483000,
      ),
    ),
    /row-level security/,
  );
  await assert.rejects(
    runWithRequestContext({ user: { tenantId: f.tenantId } }, () =>
      sync({ tenantId: f.tenantId }),
    ),
    (e) => e.status === 403,
  );
});
test.after(async () => {
  await db.$disconnect();
});
