// tests/unit/financeValidity.test.js
//
// FR-02.09/FR-02.10 / decision B1.1–B1.3 — the contract-first Finance gate:
//
//   * OFF (default, no FINANCE_SERVICE_URL): every check is a no-op — checked
//     false, valid null, no outbound call possible, submit posture unchanged.
//   * the client (advisory mode via env): a 200 OPEN in-window reference is
//     valid; a 404 is DEFINITIVELY invalid (unknown-to-finance); a 5xx or
//     transport failure is UNREACHABLE — never invalid; a CLOSED status and an
//     out-of-window validity are invalid; the budget read passes meaningful
//     nulls through.
//   * the gate: off → no evidence, no throw; advisory invalid → evidence
//     recorded, no throw; enforce invalid → 409 with the evidence attached;
//     enforce unreachable → no throw; absent reference → nothing recorded.
import { jest } from "@jest/globals";

const checkCostCenterValidity = jest.fn();
const fetchBudgetAndHeadcount = jest.fn();

jest.unstable_mockModule("../../src/lib/financeClient.js", () => ({
  checkCostCenterValidity,
  fetchBudgetAndHeadcount,
}));

const { assertFinanceValidityAtSubmit } = await import("../../src/services/financeValidity.service.js");

describe("financeValidity — the submit gate", () => {
  test("absent reference records nothing even when the client would answer", async () => {
    const snapshot = await assertFinanceValidityAtSubmit("t1", { costCenterRef: null }, null);
    expect(snapshot).toBeNull();
    expect(checkCostCenterValidity).not.toHaveBeenCalled();
  });

  test("unreachable client (checked:false) records nothing and never throws — even in enforce", async () => {
    checkCostCenterValidity.mockResolvedValueOnce({ mode: "enforce", checked: false, valid: null, state: "unverifiable" });
    const snapshot = await assertFinanceValidityAtSubmit("t1", { costCenterRef: "CC-1" }, null);
    expect(snapshot).toBeNull();
  });

  test("advisory invalid reference is recorded, not thrown", async () => {
    checkCostCenterValidity.mockResolvedValueOnce({ mode: "advisory", checked: true, valid: false, state: "unknown-to-finance" });
    const snapshot = await assertFinanceValidityAtSubmit("t1", { costCenterRef: "CC-404" }, null);
    expect(snapshot).not.toBeNull();
    expect(snapshot.costCenterValidity).toMatchObject({ valid: false, state: "unknown-to-finance", source: "finance-contract-v1" });
    // No budget read for an invalid reference (enriching it invites misreading).
    expect(fetchBudgetAndHeadcount).not.toHaveBeenCalled();
  });

  test("enforce invalid reference throws 409 with the evidence in details", async () => {
    checkCostCenterValidity.mockResolvedValueOnce({ mode: "enforce", checked: true, valid: false, state: "not-open-closed" });
    await expect(assertFinanceValidityAtSubmit("t1", { costCenterRef: "CC-DEAD" }, null)).rejects.toMatchObject({
      status: 409,
      code: "HR-RECRUITMENT-COST-CENTER-INVALID",
      details: { costCenterValidity: { valid: false, state: "not-open-closed" } },
    });
  });

  test("valid reference enriches the snapshot with the budget/headcount read and preserves prior keys", async () => {
    checkCostCenterValidity.mockResolvedValueOnce({ mode: "advisory", checked: true, valid: true, state: "valid" });
    fetchBudgetAndHeadcount.mockResolvedValueOnce({
      mode: "advisory", checked: true, fiscalYear: 2026, budget: { remaining: 380000 }, headcount: { planned: 12, filled: 9, available: 3 }, asOf: "2026-09-22T09:00:00Z",
    });
    const snapshot = await assertFinanceValidityAtSubmit("t1", { costCenterRef: "CC-1" }, { amountRule: "gate-500k" });
    expect(snapshot.amountRule).toBe("gate-500k");
    expect(snapshot.costCenterValidity).toMatchObject({ valid: true });
    expect(snapshot.budgetAtSubmit).toMatchObject({ fiscalYear: 2026, headcount: { available: 3 } });
  });

  test("a failed budget read leaves the prior snapshot keys untouched", async () => {
    checkCostCenterValidity.mockResolvedValueOnce({ mode: "advisory", checked: true, valid: true, state: "valid" });
    fetchBudgetAndHeadcount.mockResolvedValueOnce({ mode: "advisory", checked: false, reason: "finance-unreachable" });
    const snapshot = await assertFinanceValidityAtSubmit("t1", { costCenterRef: "CC-1" }, { amountRule: "gate-500k" });
    expect(snapshot.amountRule).toBe("gate-500k");
    expect(snapshot.budgetAtSubmit).toBeUndefined();
    expect(snapshot.costCenterValidity).toMatchObject({ valid: true });
  });
});

// The contract client's own tests live in financeClient.test.js — this file
// mocks the client module, so the real implementation cannot be exercised here.