import { describe, expect, it } from "@jest/globals";
import { runUpdateAfterFailure } from "../../src/lib/payrollRunFailure.js";
import { payrollReadiness } from "../../src/services/payrollReadiness.service.js";

const before = { status: "COMPLETED", processedBy: null, approvedBy: null, approvedAt: null };

describe("runUpdateAfterFailure", () => {
  it("puts the run back as it was when a precondition refused it", () => {
    const err = Object.assign(new Error("Publish attendance setup covering this payroll period"), { preflight: true });
    expect(runUpdateAfterFailure(err, before)).toEqual(before);
  });
  it("marks FAILED for a real calculation error", () => {
    expect(runUpdateAfterFailure(new Error("boom"), before)).toEqual({ status: "FAILED" });
  });
  it("marks FAILED when the run was already stuck in PROCESSING", () => {
    const err = Object.assign(new Error("x"), { preflight: true });
    expect(runUpdateAfterFailure(err, { ...before, status: "PROCESSING" })).toEqual({ status: "FAILED" });
  });
  it("marks FAILED when there is no earlier state", () => {
    const err = Object.assign(new Error("x"), { preflight: true });
    expect(runUpdateAfterFailure(err, null)).toEqual({ status: "FAILED" });
  });
});

const db = {
  bankDetail: { findMany: async () => [] },
  leaveBalance: { findMany: async () => [] },
  overtimeRequest: { findMany: async () => [] },
  payrollConfigSnapshot: { findFirst: async () => ({ config: { taxSlabs: [], payRules: { cashDisbursement: true } } }) },
};
const run = { countryCode: "PK", periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T23:59:59Z") };
const base = { tenantId: "t", run, employees: [{ id: 1, employee_code: "E1", employmentTerms: [{ currency: "PKR" }] }], db };

describe("readiness: attendance setup coverage", () => {
  it("is not checked unless asked", async () => {
    const { issues } = await payrollReadiness(base);
    expect(issues.some((i) => i.code === "ATTENDANCE_SETUP_REQUIRED")).toBe(false);
  });
  it("reports a period no published setup covers, as a calculation issue", async () => {
    const loadRuntime = async () => ({ configOn: (day) => day >= "2026-10-13" });
    const { issues } = await payrollReadiness({ ...base, checkAttendanceSetup: true, loadRuntime });
    const issue = issues.find((i) => i.code === "ATTENDANCE_SETUP_REQUIRED");
    expect(issue).toMatchObject({ phase: "CALCULATE", message: "Publish attendance setup covering this payroll period" });
  });
  it("is quiet when every day is covered", async () => {
    const loadRuntime = async () => ({ configOn: () => true });
    const { issues } = await payrollReadiness({ ...base, checkAttendanceSetup: true, loadRuntime });
    expect(issues.some((i) => i.code === "ATTENDANCE_SETUP_REQUIRED")).toBe(false);
  });
  it("treats a setup that cannot be loaded as not covered", async () => {
    const loadRuntime = async () => {
      throw new Error("no setup");
    };
    const { issues } = await payrollReadiness({ ...base, checkAttendanceSetup: true, loadRuntime });
    expect(issues.some((i) => i.code === "ATTENDANCE_SETUP_REQUIRED")).toBe(true);
  });
});
