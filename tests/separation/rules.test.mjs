// Verify the packaged contract used by HR; no sibling checkout is required.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TRANSITIONS,
  assertTransition,
  formatEmployeeCode,
  canonicalEmployeeCode,
  collisionKey,
  noticeCalculation,
  clearanceComplete,
  settlementTotal,
} from "@trusoft/contracts/employment-rules";
import { EMPLOYMENT_TOOLS, EmploymentCode } from "@trusoft/contracts/employment";
test("every legal and illegal state transition is explicit", () => {
  for (const from of Object.keys(TRANSITIONS))
    for (const to of Object.keys(TRANSITIONS)) {
      if (TRANSITIONS[from].includes(to))
        assert.doesNotThrow(() => assertTransition(from, to));
      else assert.throws(() => assertTransition(from, to));
    }
});
test("category prefixes, configurable padding and exact code validation", () => {
  assert.equal(formatEmployeeCode("MANAGEMENT", 1), "MGMT-0001");
  assert.equal(formatEmployeeCode("EMPLOYEE", 142), "EMP-0142");
  assert.equal(formatEmployeeCode("INTERNEE", 17), "INTR-0017");
  assert.equal(formatEmployeeCode("EMPLOYEE", 10000), "EMP-10000");
  assert.equal(
    formatEmployeeCode("EMPLOYEE", 4, { padding: 6, separator: "_" }),
    "EMP_000004",
  );
  assert.equal(EmploymentCode.parse(" EMP-0012 "), "EMP-0012");
  assert.throws(() => canonicalEmployeeCode("emp-0012"));
  assert.throws(() => canonicalEmployeeCode("EMP.0012"));
  assert.equal(collisionKey("EMP_0012"), collisionKey("EMP-0012"));
  assert.notEqual(collisionKey("EMP-0012"), collisionKey("EMP-012"));
});
test("notice shortfall, buyout, leap dates and early-release waiver", () => {
  const n = noticeCalculation({
    submittedOn: "2028-02-28",
    lastWorkingOn: "2028-03-01",
    requiredDays: 30,
  });
  assert.equal(n.servedDays, 2);
  assert.equal(n.shortfallDays, 28);
  assert.equal(noticeCalculation({ ...n, buyoutDays: 28 }).shortfallDays, 0);
  assert.equal(noticeCalculation({ ...n, waivedDays: 28 }).shortfallDays, 0);
  assert.throws(() => noticeCalculation({ ...n, lastWorkingOn: "2028-02-27" }));
  assert.throws(() => noticeCalculation({ ...n, buyoutDays: 31 }));
  assert.throws(() => noticeCalculation({ ...n, lastWorkingOn: "2027-02-29" }));
});
test("clearance requires every department and every asset disposition", () => {
  const c = [{ status: "COMPLETED", payload: { signedByCode: "EMP-0001" } }];
  assert.equal(clearanceComplete(c, []), true);
  assert.equal(clearanceComplete([], []), false);
  assert.equal(clearanceComplete([...c, { status: "PENDING" }], []), false);
  assert.equal(clearanceComplete(c, [{ status: "PENDING" }]), false);
  assert.equal(
    clearanceComplete(c, [
      { status: "COMPLETED", payload: { disposition: "RETURNED" } },
    ]),
    true,
  );
});
test("minor unit arithmetic and strict new contracts", () => {
  assert.equal(
    settlementTotal([
      { amountMinor: 15000, direction: "EARNING" },
      { amountMinor: 1200, direction: "DEDUCTION" },
    ]),
    13800,
  );
  assert.throws(() =>
    settlementTotal([{ amountMinor: 1.5, direction: "EARNING" }]),
  );
  assert.equal(Object.keys(EMPLOYMENT_TOOLS).length, 21);
  for (const t of Object.values(EMPLOYMENT_TOOLS)) assert.ok(t.input);
  assert.equal(
    EMPLOYMENT_TOOLS.hr_separation_create.input.safeParse({ employeeId: 2 })
      .success,
    false,
  );
});

import { hrRevertTarget } from "@trusoft/contracts/hr-approval-rules";
test("HR reverts follow the confirmed initiator/HR return policy", () => {
  assert.equal(hrRevertTarget("LINE_MANAGER"), "INITIATOR");
  assert.equal(hrRevertTarget("HR"), "INITIATOR");
  assert.equal(hrRevertTarget("MANAGEMENT"), "HR");
  assert.throws(() => hrRevertTarget("INITIATOR"));
});
