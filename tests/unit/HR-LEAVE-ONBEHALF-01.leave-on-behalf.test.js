// Issue 395 (operator, 2026-11-05) — raise a leave request ON BEHALF:
//   • HR (hr:leave POST) for any employee of the company;
//   • the employee's LINE MANAGER for a direct report, with no write grant.
// The decision is a pure function, the filing is a thin wrapper, so both are
// tested here without the approval stack or a database.
import { describe, expect, test } from "@jest/globals";

import {
  mayRaiseLeaveFor,
  RAISE_DENIED,
  RAISE_HR,
  RAISE_MANAGER,
  RAISE_SELF,
} from "../../src/lib/leaveOnBehalf.js";
import { fileLeaveForApproval } from "../../src/lib/leaveSubmission.js";

describe("HR-LEAVE-ONBEHALF-01 who may raise leave for someone else", () => {
  test("your own request is self-service, with or without any grant", () => {
    expect(
      mayRaiseLeaveFor({ actingEmployeeId: 7, canWriteOthers: false, targetEmployeeId: 7 }),
    ).toBe(RAISE_SELF);
    expect(
      mayRaiseLeaveFor({ actingEmployeeId: 7, canWriteOthers: true, targetEmployeeId: 7 }),
    ).toBe(RAISE_SELF);
  });

  test("HR raises for anyone in the company", () => {
    expect(
      mayRaiseLeaveFor({
        actingEmployeeId: 1,
        canWriteOthers: true,
        targetEmployeeId: 42,
        targetManagerId: 9,
      }),
    ).toBe(RAISE_HR);
  });

  test("a line manager raises for a direct report without any write grant", () => {
    expect(
      mayRaiseLeaveFor({
        actingEmployeeId: 9,
        canWriteOthers: false,
        targetEmployeeId: 42,
        targetManagerId: 9,
      }),
    ).toBe(RAISE_MANAGER);
  });

  test("a manager cannot raise for someone else's report, nor for a peer", () => {
    expect(
      mayRaiseLeaveFor({
        actingEmployeeId: 9,
        canWriteOthers: false,
        targetEmployeeId: 42,
        targetManagerId: 11,
      }),
    ).toBe(RAISE_DENIED);
    expect(
      mayRaiseLeaveFor({
        actingEmployeeId: 9,
        canWriteOthers: false,
        targetEmployeeId: 42,
        targetManagerId: null,
      }),
    ).toBe(RAISE_DENIED);
  });

  test("an employee without a write grant cannot raise for anyone else", () => {
    expect(
      mayRaiseLeaveFor({
        actingEmployeeId: 7,
        canWriteOthers: false,
        targetEmployeeId: 42,
        targetManagerId: null,
      }),
    ).toBe(RAISE_DENIED);
  });

  test("a session with no employee binding cannot raise at all", () => {
    expect(
      mayRaiseLeaveFor({
        actingEmployeeId: null,
        canWriteOthers: false,
        targetEmployeeId: 42,
        targetManagerId: null,
      }),
    ).toBe(RAISE_DENIED);
    expect(
      mayRaiseLeaveFor({
        actingEmployeeId: undefined,
        canWriteOthers: true,
        targetEmployeeId: 42,
      }),
    ).toBe(RAISE_HR);
  });

  test("a missing or non-numeric target is refused, never defaulted", () => {
    for (const target of [undefined, null, "", "abc", 0, -3, 1.5])
      expect(
        mayRaiseLeaveFor({ actingEmployeeId: 1, canWriteOthers: true, targetEmployeeId: target }),
      ).toBe(RAISE_DENIED);
  });
});

describe("HR-LEAVE-ONBEHALF-01 filing the request into the Approval Centre", () => {
  const created = { data: { id: 5, status: "PENDING" } };

  test("an on-behalf raise is submitted on the employee's behalf, with the basis recorded", async () => {
    const calls = [];
    const submit = async (...args) => calls.push(args);
    const out = await fileLeaveForApproval({
      response: created,
      filedForSelf: false,
      onBehalf: true,
      raisedBy: RAISE_MANAGER,
      reason: "Filed by the line manager",
      submit,
    });
    expect(calls).toEqual([
      ["LEAVE", 5, "Filed by the line manager", { onBehalf: true, managerMayFile: true }],
    ]);
    expect(out.data.submittedForApproval).toBe(true);
    expect(out.data.raisedOnBehalf).toBe(true);
    expect(out.data.raisedBy).toBe(RAISE_MANAGER);
  });

  test("a self submission still goes in as the employee, with no on-behalf flag", async () => {
    const calls = [];
    await fileLeaveForApproval({
      response: created,
      filedForSelf: true,
      onBehalf: false,
      reason: undefined,
      submit: async (...args) => calls.push(args),
    });
    // Three arguments: the self-service call keeps its original shape, so no
    // empty options object is passed for an ordinary submit.
    expect(calls).toEqual([["LEAVE", 5, "Employee submitted the leave request"]]);
  });

  test("a refused submission keeps the request and says why", async () => {
    const out = await fileLeaveForApproval({
      response: created,
      filedForSelf: false,
      onBehalf: true,
      submit: async () => {
        throw new Error("Only the employee's line manager or HR may file this request for them");
      },
    });
    expect(out.data.submittedForApproval).toBe(false);
    expect(out.data.submitNote).toMatch(/line manager or HR/);
  });

  test("nothing is submitted when the request was not created", async () => {
    const calls = [];
    const out = await fileLeaveForApproval({
      response: { data: { error: "nope" } },
      filedForSelf: false,
      onBehalf: true,
      submit: async (...args) => calls.push(args),
    });
    expect(calls).toEqual([]);
    expect(out.data.error).toBe("nope");
  });
});
