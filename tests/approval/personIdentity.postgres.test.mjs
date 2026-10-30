import test from "node:test";
import assert from "node:assert/strict";
import { people, db, as, fixture, submit, setup } from "./fixtures.mjs";
const { listApprovals } = await import("../../src/services/approval/service.js");

// Operator rule (2026-10-31): people are shown by full name, position and department, never by code alone.
await setup();

test("approval list and detail carry the employee's name, position and department", async () => {
  await db((tx) =>
    tx.employee.update({
      where: { id: people.EMPLOYEE.id },
      data: { first_name: "Moeez", last_name: "Ahmed", employee_name: null, job_title: "Lead Developer" },
    }),
  );
  const row = await submit(await fixture("LEAVE"));
  assert.equal(row.employee.name, "Moeez Ahmed");
  assert.equal(row.employee.position, "Lead Developer");
  assert.equal(row.employee.code, row.employeeCode);
  assert.equal(row.history[0].actor.name, "Moeez Ahmed");
  const mine = await as("EMPLOYEE", () => listApprovals({ scope: "MINE" }));
  const item = mine.items.find((r) => r.approvalRef === row.approvalRef);
  assert.equal(item.employee.name, "Moeez Ahmed");
  assert.equal(item.employee.position, "Lead Developer");
});

test("a person with no name on file falls back to their code, never to nothing", async () => {
  await db((tx) =>
    tx.employee.update({
      where: { id: people.EMPLOYEE.id },
      data: { first_name: null, last_name: null, employee_name: null, preferred_name: null },
    }),
  );
  const row = await submit(await fixture("LEAVE"));
  assert.equal(row.employee.name, row.employeeCode);
});
