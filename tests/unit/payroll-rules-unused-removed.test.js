import { describe, expect, it } from "@jest/globals";
import { publicRules, updatePayrollRules } from "../../src/services/payrollRuleConfig.service.js";

describe("Pay Rules API", () => {
  it("does not expose the settings the payroll engine never reads", () => {
    const row = {
      id: 1,
      lwpRecovery: true,
      midMonthExitSettlement: true,
      complianceHold: true,
      offCycleRelease: true,
      cashDisbursement: true,
    };
    const out = publicRules(row);
    expect(out).toEqual({ id: 1, lwpRecovery: true, cashDisbursement: true });
    expect(row.complianceHold).toBe(true); // the input is not mutated
  });
  it("still refuses to update them", async () => {
    for (const key of ["midMonthExitSettlement", "complianceHold", "offCycleRelease"])
      await expect(updatePayrollRules({ tenantId: "t", [key]: false })).rejects.toThrow(/not supported/);
  });
});
