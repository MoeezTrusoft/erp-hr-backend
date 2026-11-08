// TS-REQUEST-CLOSED-01 (2026-11-06) — the Timesheet must never call a request
// the system closed "Disapproved". Rustam Khan's 5 Oct case was auto-rejected
// because approved leave covered the day and the day was restated ON_LEAVE;
// the modal then read "DISAPPROVED" with "Awaiting first decision." under it.
import { describe, it, expect } from "@jest/globals";
import { isSystemClosedRequest } from "../../src/lib/attendanceRequestState.js";

describe("isSystemClosedRequest", () => {
  it("treats a REJECTED request with no approver decision as system-closed", () => {
    expect(isSystemClosedRequest("REJECTED", [])).toBe(true);
    expect(isSystemClosedRequest("REJECTED", undefined)).toBe(true);
  });

  it("never calls a real refusal system-closed", () => {
    expect(isSystemClosedRequest("REJECTED", [{ level: 3, decision: "REJECTED" }])).toBe(false);
  });

  it("leaves every other status alone", () => {
    for (const status of ["PENDING", "APPROVED", "RESOLVED", "WITHDRAWN", null, ""]) {
      expect(isSystemClosedRequest(status, [])).toBe(false);
    }
  });

  it("ignores the case of the stored status", () => {
    expect(isSystemClosedRequest("rejected", [])).toBe(true);
  });
});
