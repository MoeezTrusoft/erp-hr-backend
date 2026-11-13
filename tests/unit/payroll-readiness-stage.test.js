import { describe, expect, it } from "@jest/globals";
import { FINALIZE_ONLY, assertReady } from "../../src/services/payrollReadiness.service.js";

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
