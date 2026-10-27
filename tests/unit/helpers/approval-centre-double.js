// tests/unit/helpers/approval-centre-double.js
//
// A faithful stand-in for the HR Approval Centre's submit, for suites that mock
// src/services/approval/legacy.js.
//
// Recruitment Phase 7: a requisition's PENDING_APPROVAL flip, its transition row
// and hr.recruitment.requisition_submitted.v1 are written INSIDE the centre's
// submit transaction by onSubmit (src/services/approval/adapters.js). A mocked
// legacySubmit that only returned `{}` would make those writes vanish from every
// surface test, so this double runs the REAL onSubmit on the suite's prisma
// double (standing in for the transaction client), exactly as submitApproval
// does:
//   * env.who is the verified caller (in production: the employee the service
//     received as actorId), env.tenantId the caller's tenant;
//   * the source row is the requisition the surface named, as the centre loads
//     it (before the status flip, scoped to — so carrying — the caller's tenant);
//   * meta.reason is options.requisition.reason when the surface passed one,
//     otherwise the submit reason; meta.transitionSource is the surface's.
//
// The centre's own gates (verified identity, line-manager availability, the
// HrApprovalRequest row) are pinned in the approval suites, not here.
//
// Usage:
//   const centre = approvalCentreDouble(prisma);
//   jest.unstable_mockModule(".../approval/legacy.js", () => ({ legacyDecision, legacySubmit: centre.legacySubmit }));
//   beforeEach(() => centre.reset());
//   centre.arm({ tenantId: TENANT, actorId: 7, row: { id: 5, status: "DRAFT", ... } });
import { jest } from "@jest/globals";

const DEFAULT_REASON = "Employee submitted the request";

export function approvalCentreDouble(prisma) {
  let armed = null;

  const legacySubmit = jest.fn(async (kind, sourceRef, reason = DEFAULT_REASON, options = {}) => {
    if (!armed) {
      throw new Error(
        "approvalCentreDouble: a submit reached the centre before the test armed it with the caller and the requisition row",
      );
    }
    if (kind !== "REQUISITION") throw new Error(`approvalCentreDouble: only REQUISITION submits are simulated, got ${kind}`);
    const armedRow = typeof armed.row === "function" ? await armed.row() : armed.row;
    // The centre loads the row the surface named; a mismatch is a fixture bug.
    if (Number(armedRow?.id) !== Number(sourceRef)) {
      throw new Error(`approvalCentreDouble: armed row ${armedRow?.id} is not the submitted source ${sourceRef}`);
    }
    // loadSource reads the row WHERE tenantId = the caller's tenant, so the row
    // it hands onSubmit always carries that tenant (fixtures often omit it).
    if (armedRow.tenantId !== undefined && armedRow.tenantId !== armed.tenantId) {
      throw new Error(`approvalCentreDouble: armed row belongs to tenant ${armedRow.tenantId}, not ${armed.tenantId}`);
    }
    const row = { ...armedRow, tenantId: armed.tenantId };
    // Loaded after the suite's jest.unstable_mockModule calls, so adapters.js
    // links against the suite's prisma / event-outbox doubles.
    const { onSubmit } = await import("../../../src/services/approval/adapters.js");
    const env = { tenantId: armed.tenantId, who: { id: armed.actorId }, now: new Date() };
    await onSubmit(
      prisma,
      env,
      kind,
      { row, definition: { model: "jobRequisition" }, snapshot: {} },
      {
        reason: options.requisition ? options.requisition.reason : String(reason || DEFAULT_REASON),
        transitionSource: options.requisition?.transitionSource,
      },
    );
    return { ...row, status: "PENDING_APPROVAL" };
  });

  return {
    legacySubmit,
    arm({ tenantId, actorId, row }) {
      armed = { tenantId, actorId, row };
    },
    reset() {
      armed = null;
    },
  };
}
