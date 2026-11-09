// Shared setup for the approval-gated attendance tests (swaps, roster changes, holidays): the approval fixtures'
// company with a second rostered employee, helpers to publish the ATTENDANCE route, and to walk a request through it.
import assert from "node:assert/strict";

const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/hr_task_assessment_test")
  throw new Error("Use the isolated local HR test database");
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");

export const f = await import("../approval/fixtures.mjs");
export const { prisma, company, other, people, db, as, act } = f;
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const matrix = await import("../../src/services/approvalMatrix.service.js");

let ready;
export const ensure = (extra) => (ready ||= prepare(extra));
async function prepare(extra) {
  await f.setup();
  const calendar = await db((tx) =>
    tx.holidayCalendar.create({ data: { tenantId: company, name: `Fixture-${Date.now()}`, year: 2026, createdById: people.HR.id } }),
  );
  await db(async (tx) => {
    const v1 = await tx.attendanceSetupRelease.findFirst({ where: { tenantId: company, version: 1 } });
    const config = structuredClone(v1.config);
    config.version = 2;
    config.settings.defaultCalendarId = calendar.id;
    config.calendars = [{ id: calendar.id, year: 2026 }];
    config.employees.push({ id: people.OTHER.id, payroll_included: true, hire_date: "2026-01-01" });
    config.schedules.push({ employeeId: people.OTHER.id, effective_start_date: "2026-01-01",
      schedule_pattern: { shift: { from: "17:00", to: "23:00" }, offDays: [] } });
    await tx.attendanceSetupRelease.create({ data: { tenantId: company, version: 2, effectiveFrom: new Date("2026-01-01"),
      coverageThrough: new Date("2027-12-31"), reason: "Route fixture", config } });
  });
  if (extra) await extra({ calendar });
  return { calendar };
}

const tenantCtx = (fn) => mcpCtx.run({ user: { tenantId: company } }, fn);
const level = (name, action, who) => ({ name, action, approverMode: "NAMED", approverIds: [people[who].id] });
export const publishRoute = async () => {
  await tenantCtx(() => matrix.saveApprovalMatrixDraft({ tenantId: company, actorId: "t", kind: "ATTENDANCE",
    levels: [level("HR check", "VERIFY", "HR"), level("Management", "APPROVE", "MANAGEMENT")] }));
  await tenantCtx(() => matrix.publishApprovalMatrix({ tenantId: company, actorId: "t", kind: "ATTENDANCE", reason: "route tests" }));
};

export const approvalOf = (kind, sourceRef) =>
  db((tx) => tx.hrApprovalRequest.findFirst({ where: { tenantId: company, kind, sourceRef: String(sourceRef) } }));
/** HR verifies, Management approves (or rejects). Returns the final approval record. */
export async function decide(kind, sourceRef, finalAction = "APPROVE") {
  const ar = await approvalOf(kind, sourceRef);
  assert.ok(ar, `${kind} ${sourceRef} reached the approval route`);
  const rec = await act("HR", { approvalRef: ar.id, version: ar.version }, "VERIFY");
  return act("MANAGEMENT", rec, finalAction);
}
export const foreignEmployee = (code) =>
  mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(prisma, (tx) => tx.employee.create({ data: { tenant_id: other, employee_code: code, employeeCategory: "EMPLOYEE",
      userId: 100000 + Math.floor(Math.random() * 1e8), first_name: "Fictional", status: "Active", employement_status: "Active",
      hire_date: new Date("2026-01-01") } }), { tenantId: other }));

/** What attendance would decide for an employee on a day, from the live runtime. */
export async function dayInfo(employeeId, day) {
  const { loadAttendanceRuntime } = await import("../../src/lib/attendanceRuntime.js");
  return db(async (tx) => (await loadAttendanceRuntime({ tenantId: company, from: day, to: day, db: tx })).resolve(employeeId, day));
}
