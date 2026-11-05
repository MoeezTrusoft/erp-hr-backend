// Issue 395 (operator, 2026-11-05) — a leave request raised ON BEHALF reaches
// the Approval Centre as the EMPLOYEE's request:
//   • HR files for anyone in the company and the request stops at the employee's
//     line manager;
//   • the employee's own line manager files for a report and the manager stage is
//     theirs already, so it goes straight to HR;
//   • anybody else is refused, and the owner always comes from the source.
// Plus the list scope: a manager's screen shows their own rows and the ones they
// raised for someone else, and nothing more.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).pathname !== "/hr_task_assessment_test"
)
  throw new Error("Use the isolated local HR test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");

const { company, people, db, setup } = await import("./fixtures.mjs");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { legacySubmit } = await import("../../src/services/approval/legacy.js");
const { submitApprovalOnBehalf } = await import("../../src/services/approval/service.js");
const { getLeaveRequests, createLeaveRequest } = await import(
  "../../src/services/leave.service.js"
);
const { default: prisma } = await import("../../src/lib/prisma.js");

const GRANTS = {
  EMPLOYEE: ["self"],
  MANAGER: ["self", "manager"],
  HR: ["self", "verify", "read"],
  OTHER: ["self"],
  MANAGEMENT: ["approve", "read"],
};
const as = (role, fn) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: company,
        userId: people[role].userId,
        employeeId: people[role].id,
        roles: [role.toLowerCase()],
        isAdmin: false,
      },
      permissions: GRANTS[role].map((k) => "hr.approvals." + k),
    },
    fn,
  );

let day = 0;
const nextStart = () => new Date(Date.UTC(2027, 2, 1 + day++));

async function leaveRow({ employeeId, createdById }) {
  const start = nextStart();
  return db((tx) =>
    tx.leaveRequest.create({
      data: {
        tenantId: company,
        employeeId,
        startDate: start,
        endDate: start,
        totalDays: 1,
        reason: "Fictional on-behalf leave",
        status: "PENDING",
        createdById,
      },
    }),
  );
}

const approvalRow = (ref) =>
  db((tx) =>
    tx.hrApprovalRequest.findFirst({ where: { tenantId: company, kind: "LEAVE", sourceRef: String(ref) } }),
  );

const rejectsWith = (promise, status, text) =>
  assert.rejects(promise, (e) => {
    assert.equal(e.status ?? e.statusCode, status, e.message);
    if (text) assert.match(e.message, text);
    return true;
  });

test("HR-LEAVE-ONBEHALF-01 on-behalf leave", { timeout: 180000 }, async (t) => {
  await setup();

  await t.test("a line manager files for a direct report: the request is the employee's and skips the manager's own stage", async () => {
    const row = await leaveRow({ employeeId: people.EMPLOYEE.id, createdById: people.MANAGER.id });
    const out = await as("MANAGER", () =>
      legacySubmit("LEAVE", row.id, "Filed by the line manager", {
        onBehalf: true,
        managerMayFile: true,
      }),
    );
    assert.equal(out.status, "PENDING");
    const approval = await approvalRow(row.id);
    assert.ok(approval, "an approval request was created");
    assert.equal(approval.employeeCode, people.EMPLOYEE.employee_code);
    assert.equal(approval.stage, "HR", "the filer is the manager, so HR verifies next");
  });

  await t.test("HR files for an employee: it stops at that employee's line manager", async () => {
    const row = await leaveRow({ employeeId: people.EMPLOYEE.id, createdById: people.HR.id });
    const out = await as("HR", () =>
      legacySubmit("LEAVE", row.id, "Filed by HR", { onBehalf: true, managerMayFile: true }),
    );
    assert.equal(out.status, "PENDING");
    const approval = await approvalRow(row.id);
    assert.equal(approval.employeeCode, people.EMPLOYEE.employee_code);
    assert.equal(approval.stage, "LINE_MANAGER");
    assert.equal(approval.managerCode, people.MANAGER.employee_code);
  });

  await t.test("someone who is neither HR nor the line manager is refused", async () => {
    const row = await leaveRow({ employeeId: people.EMPLOYEE.id, createdById: people.OTHER.id });
    await rejectsWith(
      as("OTHER", () =>
        legacySubmit("LEAVE", row.id, "Not my report", { onBehalf: true, managerMayFile: true }),
      ),
      403,
      /line manager or HR/,
    );
    assert.equal(await approvalRow(row.id), null, "nothing was filed");
  });

  await t.test("the manager door cannot be used for another manager's report", async () => {
    const row = await leaveRow({ employeeId: people.OTHER.id, createdById: people.MANAGER.id });
    await rejectsWith(
      as("MANAGER", () =>
        legacySubmit("LEAVE", row.id, "Not my report", { onBehalf: true, managerMayFile: true }),
      ),
      403,
      /line manager or HR/,
    );
    assert.equal(await approvalRow(row.id), null);
  });

  await t.test("the owner always comes from the source: a payload code cannot attach the request elsewhere", async () => {
    const row = await leaveRow({ employeeId: people.EMPLOYEE.id, createdById: people.HR.id });
    // HR submits on behalf and names a different employee code in the options.
    await as("HR", () =>
      legacySubmit("LEAVE", row.id, "Wrong owner", {
        onBehalf: true,
        managerMayFile: true,
        employeeCode: people.OTHER.employee_code,
      }),
    );
    const approval = await approvalRow(row.id);
    assert.equal(approval.employeeCode, people.EMPLOYEE.employee_code, "the source owner wins");
  });

  await t.test("a direct on-behalf submit naming another employee is refused", async () => {
    const row = await leaveRow({ employeeId: people.EMPLOYEE.id, createdById: people.HR.id });
    await rejectsWith(
      as("HR", () =>
        submitApprovalOnBehalf(
          {
            kind: "LEAVE",
            sourceRef: String(row.id),
            employeeCode: people.OTHER.employee_code,
            expectedVersion: 0,
            reason: "Wrong owner",
            requestKey: randomUUID(),
          },
          { allowManagerFiler: true },
        ),
      ),
      403,
      /another employee/,
    );
  });

  await t.test("the employee's own submission is unchanged", async () => {
    const row = await leaveRow({ employeeId: people.EMPLOYEE.id, createdById: people.EMPLOYEE.id });
    await as("EMPLOYEE", () =>
      legacySubmit("LEAVE", row.id, "Employee submitted the leave request"),
    );
    const approval = await approvalRow(row.id);
    assert.equal(approval.employeeCode, people.EMPLOYEE.employee_code);
    assert.equal(approval.stage, "LINE_MANAGER");
  });

  await t.test("the manager list shows their own rows plus the ones they raised, and nothing else", async () => {
    const raised = await leaveRow({
      employeeId: people.EMPLOYEE.id,
      createdById: people.MANAGER.id,
    });
    const foreign = await leaveRow({
      employeeId: people.OTHER.id,
      createdById: people.OTHER.id,
    });
    const own = await leaveRow({
      employeeId: people.MANAGER.id,
      createdById: people.MANAGER.id,
    });
    const list = await mcpCtx.run({ user: { tenantId: company } }, () =>
      getLeaveRequests({
        tenantId: company,
        involvingEmployeeId: people.MANAGER.id,
        page: 1,
        limit: 100,
      }),
    );
    const ids = list.data.map((r) => r.id);
    assert.ok(ids.includes(raised.id), "the request raised for the report is visible");
    assert.ok(ids.includes(own.id), "their own leave is visible");
    assert.ok(!ids.includes(foreign.id), "another employee's leave is not");
  });

  await t.test("a raise on behalf may cover a day already taken; a self-service create may not", async () => {
    const past = { startDate: "2026-10-05", endDate: "2026-10-05", reason: "Fictional retrospective" };
    await assert.rejects(
      as("EMPLOYEE", () =>
        createLeaveRequest(
          { ...past, employeeId: people.EMPLOYEE.id },
          people.EMPLOYEE.id,
          company,
        ),
      ),
      /past dates/,
    );
    const created = await as("MANAGER", () =>
      createLeaveRequest(
        { ...past, employeeId: people.EMPLOYEE.id, allowPastDates: true },
        people.MANAGER.id,
        company,
      ),
    );
    assert.equal(created.employeeId, people.EMPLOYEE.id);
    assert.equal(created.createdById, people.MANAGER.id, "the filer is on record");
  });

  await prisma.$disconnect();
});
