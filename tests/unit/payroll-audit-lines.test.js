// F-08: payslip reprocess audit rows keep the replaced lines, not only totals.
import { describe, it, expect } from "@jest/globals";
import { auditLines } from "../../src/services/payrollService.js";

describe("auditLines", () => {
  it("keeps description and amount, in order, and drops ids and tenant data", () => {
    const out = auditLines({
      earnings: [{ tenantId: "t", earningTypeId: 1, amount: 33750, description: "Base salary" }, { amount: "15000.0000", description: "House Allowance" }],
      deductions: [{ tenantId: "t", deductionTypeId: 4, amount: 250, description: "Income Tax" }],
    });
    expect(out).toEqual({
      earnings: [{ description: "Base salary", amount: "33750.0000" }, { description: "House Allowance", amount: "15000.0000" }],
      deductions: [{ description: "Income Tax", amount: "250.0000" }],
    });
  });
  it("copes with empty, missing and null description input", () => {
    expect(auditLines({})).toEqual({ earnings: [], deductions: [] });
    expect(auditLines({ earnings: [{ amount: 0, description: undefined }] }).earnings).toEqual([{ description: null, amount: "0.0000" }]);
  });
  it("formats stored (\"100000\") and built (\"100000.0000\") amounts identically", () => {
    const a = auditLines({ earnings: [{ amount: "100000", description: "Base" }] });
    const b = auditLines({ earnings: [{ amount: "100000.0000", description: "Base" }] });
    expect(a).toEqual(b);
    expect(auditLines({ earnings: [{ amount: "n/a", description: "Odd" }] }).earnings[0].amount).toBe("n/a");
  });
  it("serialises Decimal-like amounts as strings so the Json column stays exact", () => {
    const decimalLike = { toString: () => "1234.5000" };
    expect(auditLines({ earnings: [{ amount: decimalLike, description: "x" }] }).earnings[0].amount).toBe("1234.5000");
    expect(() => JSON.stringify(auditLines({ earnings: [{ amount: decimalLike, description: "x" }] }))).not.toThrow();
  });
});
