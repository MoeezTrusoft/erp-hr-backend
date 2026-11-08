// F-05 end to end against Postgres: streak list, exclusions, validation, tenant isolation.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, company, people, db, as } from "../approval/fixtures.mjs";
import { listLongAbsences } from "../../src/services/longAbsence.service.js";

const d = (n) => new Date(`2026-10-${String(n).padStart(2, "0")}T00:00:00Z`);

test("long absence list: streaks, exclusions, validation, isolation", { timeout: 120000 }, async () => {
  await setup();
  const emp = people.EMPLOYEE.id, hr = people.HR.id;
  const put = (employeeId, n, status) => db((tx) => tx.attendance.create({ data: { tenantId: company, employeeId, date: d(n), status } }));
  for (let n = 1; n <= 6; n++) await put(emp, n, n === 3 ? "WEEKLY_OFF" : "ABSENT"); // 5 absent days, one weekly off inside
  await put(hr, 1, "ABSENT"); await put(hr, 2, "ABSENT"); await put(hr, 3, "PRESENT"); // came back

  const asOf = d(10);
  const r = await as("HR", () => listLongAbsences({ tenantId: company, minDays: 5, asOf }));
  assert.deepEqual(r.employees.map((e) => [e.employeeId, e.days, e.from, e.to]), [[emp, 5, "2026-10-01", "2026-10-06"]]);
  assert.equal(r.employees[0].employeeCode, people.EMPLOYEE.employee_code);

  assert.equal((await as("HR", () => listLongAbsences({ tenantId: company, minDays: 6, asOf }))).employees.length, 0);

  // Exclusions: inactive employees and those outside payroll are not listed.
  await db((tx) => tx.employee.update({ where: { id: emp }, data: { employement_status: "Inactive" } }));
  assert.equal((await as("HR", () => listLongAbsences({ tenantId: company, minDays: 5, asOf }))).employees.length, 0);
  await db((tx) => tx.employee.update({ where: { id: emp }, data: { employement_status: "Active", payroll_included: false } }));
  assert.equal((await as("HR", () => listLongAbsences({ tenantId: company, minDays: 5, asOf }))).employees.length, 0);
  await db((tx) => tx.employee.update({ where: { id: emp }, data: { payroll_included: true } }));

  // Validation.
  for (const minDays of [0, -1, 32, 2.5, "x"]) await assert.rejects(as("HR", () => listLongAbsences({ tenantId: company, minDays, asOf })), /minDays/);
  await assert.rejects(as("HR", () => listLongAbsences({ tenantId: company, minDays: 5, asOf: new Date("nope") })), /asOf/);

  // Another company sees nothing of ours.
  const other = randomUUID();
  assert.equal((await as("HR", () => listLongAbsences({ tenantId: other, minDays: 1, asOf }), other)).employees.length, 0);
});
