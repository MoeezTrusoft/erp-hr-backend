// Plan item 1.4: the payroll blocker's timesheet-submission check is exact.
import { describe, it, expect } from "@jest/globals";
import {
  hasTimesheetSubmission,
  legacySubmissionPrefix,
} from "../../src/lib/timesheetSubmissionCheck.js";

const TENANT = "t1";
// Minimal in-memory payrollAuditLog supporting the operators the check uses.
const dbWith = (rows) => ({
  payrollAuditLog: {
    findFirst: async ({ where }) =>
      rows.find(
        (r) =>
          r.tenantId === where.tenantId &&
          r.action === where.action &&
          (where.payrollRunId === undefined ||
            (r.payrollRunId ?? null) === where.payrollRunId) &&
          (!where.details?.startsWith || r.details.startsWith(where.details.startsWith)),
      ) ?? null,
  },
});
const row = (o) => ({ tenantId: TENANT, action: "TIMESHEET_SUBMITTED", payrollRunId: null, details: "", ...o });
const check = (rows, run, month) =>
  hasTimesheetSubmission(dbWith(rows), { tenantId: TENANT, run, month });

describe("hasTimesheetSubmission", () => {
  it("accepts the audit row linked to this very run", async () => {
    const rows = [row({ payrollRunId: 26, details: "Timesheet for 2026-09 submitted by X" })];
    expect(await check(rows, { id: 26 }, "2026-09")).toBe(true);
  });
  it("a row linked to another run does not unlock this run", async () => {
    const rows = [row({ payrollRunId: 26, details: "Timesheet for 2026-09 submitted by X" })];
    expect(await check(rows, { id: 27 }, "2026-09")).toBe(false);
  });
  it("a 2026-10 submission never satisfies a 2026-01 run, and the reverse", async () => {
    const oct = [row({ details: legacySubmissionPrefix("2026-10") + " by HR" })];
    const jan = [row({ details: legacySubmissionPrefix("2026-01") + " by HR" })];
    expect(await check(oct, { id: 1 }, "2026-01")).toBe(false);
    expect(await check(jan, { id: 2 }, "2026-10")).toBe(false);
  });
  it("text that merely mentions the month is not a submission", async () => {
    const rows = [row({ details: "Synthetic screen-refresh acceptance test timesheet 2026-10." })];
    expect(await check(rows, { id: 3 }, "2026-10")).toBe(false);
  });
  it("still honours an old unlinked row written by the gatekeeper for that month", async () => {
    const rows = [row({ details: "Timesheet for 2026-09 submitted by HR; vault run #19 activated as PENDING" })];
    expect(await check(rows, { id: 19 }, "2026-09")).toBe(true);
  });
  it("another tenant's submission never counts", async () => {
    const rows = [row({ tenantId: "t2", payrollRunId: 5, details: "Timesheet for 2026-09 submitted" })];
    expect(await check(rows, { id: 5 }, "2026-09")).toBe(false);
  });
});
