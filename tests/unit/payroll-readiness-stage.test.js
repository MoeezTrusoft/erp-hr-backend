import { describe, expect, it, jest } from "@jest/globals";
import { FINALIZE_ONLY, assertReady, payrollReadiness } from "../../src/services/payrollReadiness.service.js";

const bank = { code: "BANK_REQUIRED", message: "EMP-1: Primary bank account and routing details are required" };
const salary = { code: "SALARY_REQUIRED", message: "EMP-2: Effective salary terms are missing" };

describe("payroll readiness stages", () => {
  it("lets calculation proceed past finalize-only issues", () => {
    expect(() => assertReady([bank], { stage: "CALCULATE" })).not.toThrow();
  });
  it("still blocks calculation on real calculation issues, naming only those", () => {
    expect(() => assertReady([bank, salary], { stage: "CALCULATE" })).toThrow(/salary terms/);
    try {
      assertReady([bank, salary], { stage: "CALCULATE" });
    } catch (e) {
      expect(e.details.issues).toEqual([salary]);
    }
  });
  it("blocks finalize on every issue", () => {
    expect(() => assertReady([bank])).toThrow(/Primary bank/);
  });
  it("lists the finalize-only codes", () => {
    expect([...FINALIZE_ONLY].sort()).toEqual(["BANK_REQUIRED", "NEGATIVE_LEAVE", "OVERTIME_PENDING"]);
  });
});

describe("leave reconciliation readiness", () => {
  const run = { periodStart: new Date("2026-10-01T00:00:00Z"), periodEnd: new Date("2026-10-31T00:00:00Z"), currencyCode: "PKR", countryCode: "PK" };
  const emp = { id: 7, employee_code: "EMP-7", attendanceInputMode: "MANUAL_MONTHLY", employmentTerms: [{ currency: "PKR" }] };
  const mk = (stored) => ({
    bankDetail: { findMany: jest.fn().mockResolvedValue([]) },
    leaveBalance: { findMany: jest.fn().mockResolvedValue([]) },
    overtimeRequest: { findMany: jest.fn().mockResolvedValue([]) },
    payrollConfigSnapshot: { findFirst: jest.fn().mockResolvedValue({ config: {} }) },
    monthlyPayrollAttendance: { findMany: jest.fn().mockResolvedValue([{ employeeId: 7, payableDays: stored }]) },
    leaveRequest: { findMany: jest.fn().mockResolvedValue([{ id: 1, employeeId: 7, startDate: new Date("2026-10-05"), endDate: new Date("2026-10-08"), totalDays: 4, leavePolicy: { leaveTypeCode: "UNPAID" }, days: [] }]) },
  });
  it("blocks calculation when leave was approved after payable days were saved", async () => {
    const db = mk(31);
    const { issues } = await payrollReadiness({ tenantId: "t", run, employees: [emp], db });
    const issue = issues.find((i) => i.code === "LEAVE_NOT_RECONCILED");
    expect(issue).toMatchObject({ phase: "CALCULATE", employeeCode: "EMP-7" });
    expect(issue.message).toBe("EMP-7: payable days 31 + approved unpaid leave 4 exceed 31 days in October 2026; update Offices & monthly attendance");
    expect(() => assertReady(issues, { stage: "CALCULATE" })).toThrow(/LEAVE_NOT_RECONCILED|approved unpaid leave/);
    expect(db.leaveRequest.findMany).toHaveBeenCalledTimes(1);
  });
  it("no issue when payable + unpaid equals month days", async () => {
    const { issues } = await payrollReadiness({ tenantId: "t", run, employees: [emp], db: mk(27) });
    expect(issues.some((i) => i.code === "LEAVE_NOT_RECONCILED")).toBe(false);
  });
});
