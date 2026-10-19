// src/services/financeValidity.service.js
//
// FR-02.09/FR-02.10 / decision B1.1–B1.3 — the COST-CENTER VALIDITY gate on
// requisition submission, consuming the contract-first Finance interface
// (hr-data/recruitment/finance-interface-contract.md).
//
// Posture (contract §6, approved):
//   * FINANCE_SERVICE_URL unset → the gate is DORMANT. Submission behaves
//     byte-identically to the pre-contract build: the mandatory-field gate
//     proves the reference is present; nothing claims it is valid.
//   * advisory → an invalid/unverifiable reference is RECORDED (on the
//     requisition's budgetApprovalSnapshot, namespaced under costCenterValidity)
//     and surfaced in the submit response, but never blocks.
//   * enforce → a reference that Finance definitively answers INVALID (unknown
//     id, not-open status, outside validity window) BLOCKS submission with 409.
//     An UNREACHABLE Finance never blocks — availability ≠ validity — it records
//     "unverifiable" and the existing fail-closed amount gate still applies.
//
// Headcount (decision B1.3): no headcount authority exists yet (HR Position
// carries no headcount; no Workforce-Planning service). The budget/headcount
// read is therefore advisory-only enrichment — it feeds the snapshot, never a
// gate. When the authority lands, only this file's collect step changes.
import { checkCostCenterValidity, fetchBudgetAndHeadcount } from "../lib/financeClient.js";

const invalid = (evidence) =>
  Object.assign(
    new Error(
      `Cost center "${evidence.costCenterRef}" is not valid in Finance (${evidence.state}); submission blocked by FINANCE_VALIDITY_MODE=enforce`,
    ),
    { status: 409, code: "HR-RECRUITMENT-COST-CENTER-INVALID", details: { costCenterValidity: evidence } },
  );

const namespacedSnapshot = (existing, validity, budget) => {
  const prior = existing && typeof existing === "object" ? existing : {};
  return {
    ...prior,
    costCenterValidity: validity,
    // The §3 read is enrichment: only present when Finance answered. A skipped
    // read leaves any prior budget keys untouched rather than wiping them.
    ...(budget ? { budgetAtSubmit: budget } : {}),
  };
};

/**
 * Run the submit-time validity check for one requisition.
 *
 * @returns {Promise<object|null>} the evidence to persist (null = nothing to
 *   record: the gate is dormant or the reference is absent — the mandatory-field
 *   gate already owns the "present" refusal), after possibly throwing in
 *   enforce mode.
 */
export const collectCostCenterValidityEvidence = async (tenantId, requisition, existingSnapshot = null) => {
  const ref = requisition?.costCenterRef ?? null;
  if (!ref || !String(ref).trim()) return null;

  const validity = await checkCostCenterValidity(tenantId, ref);
  if (!validity.checked) return null; // off-mode or unreachable — record nothing, block nothing here

  const evidence = {
    checkedAt: new Date().toISOString(),
    costCenterRef: ref,
    valid: validity.valid,
    state: validity.state,
    source: "finance-contract-v1",
  };

  if (validity.valid === false && validity.mode === "enforce") {
    throw invalid(evidence);
  }

  // The §3 budget/headcount read runs only when the reference looks usable —
  // enriching an invalid reference's snapshot with a budget for it invites the
  // reader to think the reference was fine.
  const budget = validity.valid ? await fetchBudgetAndHeadcount(tenantId, ref) : null;

  return {
    evidence,
    budget: budget?.checked ? { fiscalYear: budget.fiscalYear, budget: budget.budget, headcount: budget.headcount, asOf: budget.asOf } : null,
    snapshot: namespacedSnapshot(existingSnapshot, evidence, budget?.checked ? { fiscalYear: budget.fiscalYear, budget: budget.budget, headcount: budget.headcount, asOf: budget.asOf } : null),
  };
};

/**
 * The submit-gate wrapper: assert (may throw in enforce mode) and return the
 * snapshot patch to write with the submission. Returns null when dormant.
 */
export const assertFinanceValidityAtSubmit = async (tenantId, requisition, existingSnapshot = null) => {
  const result = await collectCostCenterValidityEvidence(tenantId, requisition, existingSnapshot);
  if (!result) return null;
  return result.snapshot;
};
