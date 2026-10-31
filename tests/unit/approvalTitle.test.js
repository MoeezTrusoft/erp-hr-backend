import { describe, expect, it } from "@jest/globals";
import { requestTitle } from "../../src/lib/approvalTitle.js";

describe("requestTitle", () => {
  it("names an attendance case by what happened and the day", () => {
    expect(requestTitle("ATTENDANCE", { type: "LATE_CHECKIN", date: "2026-10-27T00:00:00Z" })).toBe("Late check-in, 27 Oct");
    expect(requestTitle("ATTENDANCE", { type: "ABSENT" })).toBe("Absent");
    expect(requestTitle("ATTENDANCE", { type: "SOMETHING_NEW", date: "2026-10-27" })).toBeNull();
  });
  it("names leave by its dates and days", () => {
    expect(requestTitle("LEAVE", { startDate: "2026-11-03", endDate: "2026-11-07", totalDays: 5 })).toBe("Leave, 3 Nov to 7 Nov (5 days)");
    expect(requestTitle("LEAVE", { startDate: "2026-11-03", endDate: "2026-11-03", totalDays: 1 })).toBe("Leave, 3 Nov (1 day)");
  });
  it("names overtime, claims, loans and payroll", () => {
    expect(requestTitle("OVERTIME", { date: "2026-10-20", hours: 2 })).toBe("Overtime, 20 Oct, 2 hours");
    expect(requestTitle("CLAIM", { title: "Taxi to client" })).toBe("Claim: Taxi to client");
    expect(requestTitle("LOAN", { kind: "ADVANCE" })).toBe("Salary advance");
    expect(requestTitle("PAYROLL", { periodStart: "2026-09-01", totalNet: 1355785, currencyCode: "PKR" })).toBe("Payroll for September 2026, net PKR 1,355,785");
  });
  it("has no title for unknown kinds or empty snapshots", () => {
    expect(requestTitle("TIMESHEET", {})).toBeNull();
    expect(requestTitle("LEAVE", null)).toBeNull();
  });
});
