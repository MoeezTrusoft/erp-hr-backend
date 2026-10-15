// PostgreSQL contract tests for hr.availability.changed.v1 (migration
// 20261015130000_pm_availability_events) and the hr-directory lookups.
//
// Creates a disposable database next to the isolated HR test database
// (ASSESSMENT_TEST_ADMIN_URL, as in the other native suites), builds the
// schema from prisma/schema.prisma, applies the migration's trigger section,
// puts the trigger source tables and outbox_events under FORCE RLS like
// production, and writes as a non-owner role (SET LOCAL ROLE) with the tenant
// GUC set. Every emitted outbox row is parsed with the contracts
// HrAvailabilityChanged envelope schema.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { HrAvailabilityChanged } from "@trusoft/contracts/events/pm-execution";

const APP_ROLE = "hr_availability_test_app";
const MIGRATION = "prisma/migrations/20261015130000_pm_availability_events/migration.sql";
const A = randomUUID();
const B = randomUUID();

const adminUrl = new URL(process.env.ASSESSMENT_TEST_ADMIN_URL || "http://invalid");
if (adminUrl.hostname !== "127.0.0.1" || adminUrl.pathname !== "/hr_task_assessment_test")
  throw new Error("Use the isolated local HR test database admin");
const dbName = "hr_availability_" + randomUUID().replaceAll("-", "");
const dbUrl = new URL(adminUrl);
dbUrl.pathname = "/" + dbName;

let admin, db, prisma;

async function schemaSql() {
  const dir = await mkdtemp(join(tmpdir(), "hr-availability-"));
  try {
    const path = join(dir, "schema.prisma");
    await writeFile(path, await readFile("prisma/schema.prisma", "utf8"));
    const diff = spawnSync(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema", path, "--script"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, DATABASE_URL: dbUrl.toString() } },
    );
    if (diff.status !== 0) throw new Error(diff.stderr || "schema generation failed");
    return diff.stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const policy = (table, column) => `
  ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON "${table}"
    USING ("${column}" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
    WITH CHECK ("${column}" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');`;

/** Run fn(client) in one transaction as the non-owner role for `tenant`. */
async function as(tenant, fn, { rollback = false } = {}) {
  await db.query("BEGIN");
  try {
    await db.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const out = await fn(db);
    await db.query(rollback ? "ROLLBACK" : "COMMIT");
    return out;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

const seen = new Set();
/** Outbox availability events written since the previous call (admin read). */
async function newEvents() {
  const { rows } = await admin.query(
    `SELECT id, "aggregateId", "tenantId", payload FROM outbox_events
      WHERE "eventName" = 'hr.availability.changed.v1' ORDER BY "createdAt", id`,
  );
  return rows
    .filter((row) => !seen.has(row.id) && seen.add(row.id))
    .map((row) => {
      const env = HrAvailabilityChanged.parse(row.payload);
      assert.equal(row.aggregateId, String(env.payload.employeeId));
      assert.equal(row.tenantId, env.tenantId);
      return env;
    });
}

async function employee(tenant, code, extra = {}) {
  return as(tenant, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO "Employee"(tenant_id, employee_code, "userId", employement_status, status, "managerId", updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
      [tenant, code, extra.userId ?? null, extra.employmentStatus ?? "Active", extra.status ?? "Active", extra.managerId ?? null],
    );
    return rows[0].id;
  });
}

const day = (offset) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

test.before(async () => {
  admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const setup = new pg.Client({ connectionString: dbUrl.toString() });
  await setup.connect();
  try {
    await setup.query(await schemaSql());
    await setup.query(
      "CREATE FUNCTION public.hr_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$;",
    );
    for (const [table, column] of [
      ["Employee", "tenant_id"], ["leave_requests", "tenantId"], ["Leave", "tenantId"],
      ["holidays", "tenantId"], ["holiday_calendars", "tenantId"],
      ["employee_holiday_calendars", "tenantId"], ["outbox_events", "tenantId"],
    ]) await setup.query(policy(table, column));
    const migration = await readFile(MIGRATION, "utf8");
    const section = migration.indexOf("-- PM availability triggers");
    assert.ok(section > 0, "migration trigger section marker missing");
    await setup.query("BEGIN; SELECT set_config('app.tenant_bypass','on',true);" + migration.slice(section));
    // Create (never alter) the disposable non-owner role, then grant it here.
    await setup.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}') THEN
         CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
       GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
       GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};`,
    );
  } finally {
    await setup.end();
  }
  db = new pg.Client({ connectionString: dbUrl.toString() });
  await db.connect();
  await admin.end();
  admin = new pg.Client({ connectionString: dbUrl.toString() });
  await admin.connect();
});

test.after(async () => {
  await prisma?.$disconnect().catch(() => {});
  await db?.end().catch(() => {});
  await admin?.end().catch(() => {});
  const drop = new pg.Client({ connectionString: adminUrl.toString() });
  await drop.connect();
  try {
    await drop.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await drop.end();
  }
});

let emp, peer, manager;

test("employee insert publishes one contract-valid snapshot with an empty exception list", async () => {
  manager = await employee(A, "MGR-1", { userId: 90 });
  emp = await employee(A, "EMP-1", { userId: 41, managerId: manager });
  peer = await employee(A, "EMP-2", { userId: 0 });
  const events = await newEvents();
  assert.equal(events.length, 3);
  const mine = events.find((e) => e.payload.employeeId === emp);
  assert.equal(mine.name, "hr.availability.changed.v1");
  assert.equal(mine.tenantId, A);
  assert.deepEqual(mine.actor, { type: "service", id: "erp-hr-backend" });
  assert.equal(mine.payload.userId, 41);
  assert.equal(mine.payload.available, true);
  assert.equal(mine.payload.sourceVersion, "1");
  assert.deepEqual(mine.payload.exceptions, []);
  assert.equal(mine.payload.exceptionsFrom, day(-90));
  assert.equal(mine.payload.exceptionsTruncated, false);
  // userId 0 is not an RBAC id.
  assert.equal(events.find((e) => e.payload.employeeId === peer).payload.userId, null);
});

test("an approval writing the request and its legacy mirror in one transaction emits one coalesced snapshot", async () => {
  await as(A, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO leave_requests("tenantId","employeeId","startDate","endDate","totalDays",status,"createdById",updated_at)
       VALUES ($1,$2,$3,$4,1.5,'PENDING',$2,now()) RETURNING id`,
      [A, emp, day(10), day(11)],
    );
    await c.query(
      `INSERT INTO "Leave"("tenantId","employeeId",type,start_date,end_date,total_days,status,updated_at)
       VALUES ($1,$2,'ANNUAL',$3,$4,2,'APPROVED',now())`,
      [A, emp, day(10), day(11)],
    );
    await c.query(`UPDATE leave_requests SET status='APPROVED' WHERE id=$1`, [rows[0].id]);
  });
  const events = await newEvents();
  assert.equal(events.length, 1);
  const { payload } = events[0];
  assert.equal(payload.employeeId, emp);
  assert.equal(payload.sourceVersion, "2");
  assert.equal(payload.exceptions.length, 1, "legacy mirror of an approved request is not duplicated");
  assert.match(payload.exceptions[0].source, /^request:\d+$/);
  assert.deepEqual(
    { ...payload.exceptions[0], source: undefined },
    { source: undefined, kind: "LEAVE", startDate: day(10), endDate: day(11), precise: false },
  );
});

test("pending leave, irrelevant column updates and rolled-back writes emit nothing", async () => {
  await as(A, (c) =>
    c.query(
      `INSERT INTO leave_requests("tenantId","employeeId","startDate","endDate","totalDays",status,"createdById",updated_at)
       VALUES ($1,$2,$3,$3,1,'PENDING',$2,now())`,
      [A, emp, day(20)],
    ),
  );
  await as(A, async (c) => {
    await c.query(`UPDATE leave_requests SET notes='checked' WHERE "employeeId"=$1`, [emp]);
    await c.query(`UPDATE "Employee" SET city='Lahore', employement_status='Active' WHERE id=$1`, [emp]);
  });
  await as(A, (c) =>
    c.query(
      `INSERT INTO "Leave"("tenantId","employeeId",type,start_date,end_date,total_days,status,updated_at)
       VALUES ($1,$2,'SICK',$3,$3,1,'APPROVED',now())`,
      [A, emp, day(30)],
    ), { rollback: true });
  assert.deepEqual(await newEvents(), []);
  const { rows } = await admin.query(
    `SELECT version FROM hr_pm_availability_versions WHERE "tenantId"=$1 AND "employeeId"=$2`, [A, emp]);
  assert.equal(rows[0].version, "2");
});

test("holiday changes fan out once per assigned employee per transaction, honouring effective dates", async () => {
  await as(A, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO holiday_calendars("tenantId",name,"createdById",updated_at) VALUES ($1,'PK',$2,now()) RETURNING id`,
      [A, emp],
    );
    const cal = rows[0].id;
    await c.query(
      `INSERT INTO employee_holiday_calendars("tenantId","employeeId","holidayCalendarId","effectiveFrom")
       VALUES ($1,$2,$4,$5), ($1,$3,$4,$5)`,
      [A, emp, peer, cal, day(-5)],
    );
    await c.query(
      `INSERT INTO holidays("tenantId","holidayCalendarId",date,name,"fullDay","createdById",updated_at)
       VALUES ($1,$2,$3,'Before effective',true,$4,now()), ($1,$2,$5,'Day one',true,$4,now()),
              ($1,$2,$6,'Half day',false,$4,now())`,
      [A, cal, day(-10), emp, day(40), day(41)],
    );
    await c.query(
      `INSERT INTO holidays("tenantId","holidayCalendarId",date,name,"createdById",updated_at)
       VALUES ($1,$2,$3,'Second statement',$4,now())`,
      [A, cal, day(42), emp],
    );
  });
  const events = await newEvents();
  assert.deepEqual(events.map((e) => e.payload.employeeId).sort(), [emp, peer].sort());
  const holidays = events
    .find((e) => e.payload.employeeId === peer)
    .payload.exceptions.filter((x) => x.kind === "HOLIDAY");
  assert.deepEqual(
    holidays.map((h) => [h.startDate, h.endDate, h.precise]),
    [[day(40), day(40), true], [day(41), day(41), false], [day(42), day(42), true]],
  );
});

test("the snapshot is bounded: 90-day lookback and at most 1000 nearest exceptions", async () => {
  await as(A, async (c) => {
    await c.query(
      `INSERT INTO "Leave"("tenantId","employeeId",type,start_date,end_date,total_days,status,updated_at)
       VALUES ($1,$2,'OLD',$3,$3,1,'APPROVED',now())`,
      [A, peer, day(-200)],
    );
    await c.query(
      `INSERT INTO "Leave"("tenantId","employeeId",type,start_date,end_date,total_days,status,updated_at)
       SELECT $1,$2,'BULK',d,d,1,'APPROVED',now()
         FROM generate_series(current_date + 100, current_date + 1104, interval '1 day') d`,
      [A, peer],
    );
  });
  const [event] = await newEvents();
  const { exceptions, exceptionsTruncated } = event.payload;
  assert.equal(exceptions.length, 1000);
  assert.equal(exceptionsTruncated, true);
  assert.ok(!exceptions.some((x) => x.startDate === day(-200)), "items before the lookback are dropped");
  const starts = exceptions.map((x) => x.startDate);
  assert.deepEqual(starts, [...starts].sort());
  assert.equal(starts[0], day(40), "nearest items are kept first");
});

test("separation makes the employee unavailable; tenant isolation holds for versions and pending rows", async () => {
  await as(A, (c) => c.query(`UPDATE "Employee" SET employement_status='Separated' WHERE id=$1`, [emp]));
  const [event] = await newEvents();
  assert.equal(event.payload.employeeId, emp);
  assert.equal(event.payload.available, false);
  // 1 insert, 2 approval, 3 holiday calendar transaction, 4 separation.
  assert.equal(event.payload.sourceVersion, "4");

  const other = await employee(B, "EMP-1", { userId: 41 });
  const [bEvent] = await newEvents();
  assert.equal(bEvent.tenantId, B);
  assert.equal(bEvent.payload.employeeId, other);
  const seen = await as(B, (c) =>
    c.query(`SELECT "tenantId" FROM hr_pm_availability_versions UNION ALL SELECT "tenantId" FROM outbox_events`));
  assert.ok(seen.rows.every((r) => r.tenantId === B));
  const pending = await admin.query("SELECT count(*)::int n FROM hr_pm_availability_pending");
  assert.equal(pending.rows[0].n, 0);
});

test("outbox inserts notify hr_outbox at commit (LISTEN wake)", async () => {
  const listener = new pg.Client({ connectionString: dbUrl.toString() });
  await listener.connect();
  try {
    await listener.query("LISTEN hr_outbox");
    const got = new Promise((resolve) => listener.once("notification", resolve));
    await as(A, (c) => c.query(`UPDATE "Employee" SET status='Suspended' WHERE id=$1`, [peer]));
    const msg = await Promise.race([got, new Promise((_, r) => setTimeout(() => r(new Error("no notify")), 5000))]);
    assert.equal(msg.channel, "hr_outbox");
    await newEvents();
  } finally {
    await listener.end();
  }
});

test("hr-directory lookups against PostgreSQL are tenant scoped and use the lookup indexes", async () => {
  process.env.DATABASE_URL = dbUrl.toString();
  process.env.NODE_ENV = "test";
  process.env.HR_C4_ENCRYPTION_KEY ||= Buffer.alloc(32, 17).toString("base64");
  ({ default: prisma } = await import("../../src/lib/prisma.js"));
  const { mcpCtx } = await import("../../src/mcp/context.js");
  const { resolveEmployeeIdentity, listSkillHolders } = await import("../../src/services/hr-directory.service.js");
  const inA = (fn) => mcpCtx.run({ user: { tenantId: A } }, fn);
  const inB = (fn) => mcpCtx.run({ user: { tenantId: B } }, fn);

  await as(A, async (c) => {
    const { rows } = await c.query(`INSERT INTO skills("tenantId",name) VALUES ($1,'React') RETURNING id`, [A]);
    await c.query(
      `INSERT INTO employee_skills("tenantId","employeeId","skillId",score,level,verified)
       VALUES ($1,$2,$5,92,'Expert',false), ($1,$3,$5,70,null,true), ($1,$4,$5,30,'Beginner',true)`,
      [A, emp, peer, manager, rows[0].id],
    );
  });

  assert.deepEqual(await inA(() => resolveEmployeeIdentity({ employeeCode: "EMP-1" }, { tenantId: A })), {
    employeeId: emp, employeeCode: "EMP-1", userId: 41, managerEmployeeId: manager,
  });
  assert.equal((await inA(() => resolveEmployeeIdentity({ userId: 41 }, { tenantId: A }))).employeeId, emp);
  await assert.rejects(
    inB(() => resolveEmployeeIdentity({ employeeId: emp }, { tenantId: B })),
    (e) => e.httpStatus === 404,
  );

  const all = await inA(() => listSkillHolders({ skill: "react" }, { tenantId: A }));
  assert.deepEqual(all.items.map((i) => i.employeeId), [peer, manager, emp], "verified first, then score");
  const advanced = await inA(() => listSkillHolders({ skill: "React", minLevel: "Advanced" }, { tenantId: A }));
  assert.deepEqual(advanced.items.map((i) => [i.employeeId, i.level, i.score]), [[peer, null, 70], [emp, "Expert", 92]]);
  const verified = await inA(() => listSkillHolders({ skill: "React", verifiedOnly: true, limit: 1 }, { tenantId: A }));
  assert.deepEqual(verified.items.map((i) => i.employeeId), [peer]);
  await assert.rejects(inB(() => listSkillHolders({ skill: "React" }, { tenantId: B })), (e) => e.httpStatus === 404);

  const { rows } = await admin.query(
    `SELECT indexname FROM pg_indexes WHERE indexname IN
     ('Employee_tenant_id_userId_idx','employee_skills_tenantId_skillId_verified_score_idx') ORDER BY 1`);
  assert.equal(rows.length, 2);
});
