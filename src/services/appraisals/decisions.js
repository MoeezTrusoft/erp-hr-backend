import * as C from "@trusoft/contracts/performance-appraisals";
import { localDate } from "@trusoft/contracts/performance-appraisal-rules";
import {
  run,
  fail,
  permit,
  expected,
  review,
  independent,
  audit,
  digest,
} from "./base.js";

export const decisionCreate = (raw) => {
  const i = C.DecisionCreate.parse(raw);
  return run(
    "decision.create",
    i,
    "hr.performance.decision.propose",
    async (tx, e) => {
      const { row } = await review(tx, e, i.reviewId);
      if (!["RELEASED", "ACKNOWLEDGED"].includes(row.state))
        fail(
          "STATE_CONFLICT",
          "Only a released outcome supports a decision",
          409,
        );
      if (i.kind === "COMPENSATION")
        permit(e, "hr.performance.compensation.propose");
      if (row.employeeId === e.who.id)
        fail(
          "FORBIDDEN",
          "Employees cannot propose their own consequential decision",
          403,
        );
      const decision = await tx.perfDecisionCase.create({
        data: {
          tenantId: e.tenantId,
          reviewId: row.id,
          revisionId: row.currentRevisionId,
          employeeId: row.employeeId,
          kind: i.kind,
          rationale: i.rationale,
          instruction: i.instruction || {},
          proposedBy: e.who.id,
        },
      });
      await audit(tx, e, "DECISION_PROPOSE", decision.id, 0, i);
      return { id: decision.id, version: 0, state: decision.state };
    },
  );
};
export const decisionAction = (raw) => {
  const i = C.DecisionAction.parse(raw);
  return run(
    "decision.action",
    i,
    "hr.performance.decision.approve",
    async (tx, e) => {
      const d = await tx.perfDecisionCase.findFirst({
        where: { id: i.id, tenantId: e.tenantId },
      });
      if (!d) fail("NOT_FOUND", "Decision not found", 404);
      expected(d, i.expectedVersion);
      const { row, cycle } = await review(tx, e, d.reviewId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${e.tenantId + ":decision:" + row.id},0))`;
      if (
        d.revisionId !== row.currentRevisionId ||
        !["RELEASED", "ACKNOWLEDGED"].includes(row.state)
      )
        fail(
          "REVISION_CHANGED",
          "Repropose the decision against the current released revision",
          409,
        );
      if (
        await tx.perfAppeal.findFirst({
          where: { tenantId: e.tenantId, reviewId: row.id, status: "OPEN" },
        })
      )
        fail("APPEAL_HOLD", "Decision is held by an open appeal", 409);
      independent(
        e,
        row,
        [d.proposedBy, d.hrApprover, d.budgetApprover].filter(Boolean),
      );
      let state, field;
      if (i.action === "APPROVE_HR") {
        permit(e, "hr.performance.decision.hr");
        if (d.state !== "PROPOSED")
          fail("STATE_CONFLICT", "HR approval is unavailable", 409);
        state = "HR_APPROVED";
        field = "hrApprover";
      } else if (i.action === "APPROVE_BUDGET") {
        permit(e, "hr.performance.decision.budget");
        if (d.state !== "HR_APPROVED")
          fail("STATE_CONFLICT", "Budget approval is unavailable", 409);
        state = "BUDGET_APPROVED";
        field = "budgetApprover";
      } else if (i.action === "APPROVE_EXECUTION") {
        permit(e, "hr.performance.decision.execute");
        if (d.state !== "BUDGET_APPROVED")
          fail("STATE_CONFLICT", "Execution approval is unavailable", 409);
        if (localDate(e.now, cycle.timezone) <= row.appealDeadline)
          fail(
            "APPEAL_WINDOW_OPEN",
            "Execution must wait until the appeal filing window ends",
            409,
          );
        state = "SHADOW_READY";
        field = "executionApprover";
        const businessKey = `performance:${d.id}:${d.version + 1}`;
        await tx.perfIntegrationHandoff.create({
          data: {
            tenantId: e.tenantId,
            decisionId: d.id,
            decisionVersion: d.version + 1,
            destination: d.kind === "COMPENSATION" ? "HR_PAYROLL" : d.kind,
            businessKey,
            payloadHash: digest({
              revisionId: d.revisionId,
              instruction: d.instruction,
            }),
            state: "SHADOW",
          },
        });
      } else {
        if (["SHADOW_READY", "CANCELLED"].includes(d.state))
          fail(
            "STATE_CONFLICT",
            "Cancellation requires downstream reconciliation",
            409,
          );
        state = "CANCELLED";
      }
      await tx.perfDecisionCase.update({
        where: { id: d.id },
        data: {
          state,
          version: { increment: 1 },
          ...(field ? { [field]: e.who.id } : {}),
        },
      });
      await audit(tx, e, "DECISION_" + i.action, d.id, d.version + 1, i);
      return { id: d.id, version: d.version + 1, state };
    },
  );
};
