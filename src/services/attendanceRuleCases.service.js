import { createHash } from "node:crypto";
import { RULE_TYPES } from "../lib/attendanceAnomalyRules.js";
import { reconcileRulePayroll } from "./attendanceRulePayroll.service.js";
const json = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
// The Approval Centre request that was submitted for this case. A re-evaluation
// can close or re-state the evidence under it; leaving the request PENDING made
// every later click fail with HR-4200 "The source is not ready for approval"
// (seen in production on Trusoft 2632/2637/2204/2304 and HomeVision 2408).
async function closeRaisedRequest(db, tenantId, row, reason) {
  if (!row.factHash) return 0;
  const closed = await db.hrApprovalRequest.updateMany({
    where: {
      tenantId,
      kind: "ATTENDANCE",
      sourceRef: `${row.id}@${row.factHash}`,
      execution: "PENDING",
    },
    data: {
      stage: "WITHDRAWN",
      execution: "APPLIED",
      version: { increment: 1 },
    },
  });
  if (!closed.count) return 0;
  await db.attendanceRuleAudit.create({
    data: {
      tenantId,
      employeeId: row.employeeId,
      anomalyId: row.id,
      action: "REQUEST_WITHDRAWN",
      actorId: "attendance-rules",
      data: json({ reason }),
    },
  });
  return closed.count;
}
export async function syncRuleCases(
  db,
  { tenantId, employeeId, day, sessions, now = new Date() },
) {
  const old = await db.attendanceAnomaly.findMany({
    where: { tenantId, employeeId, date: day, rulesVersion: 2 },
  });
  const desired = new Map();
  const held = new Set(
    sessions
      .filter(
        (s) =>
          s.verdict.processingState === "AWAITING_DATA" ||
          ["SETUP_REQUIRED", "PUNCH_CONFLICT"].includes(s.verdict.status) ||
          (s.verdict.issues || []).some((i) => i.code !== "UNMATCHED_OUT"),
      )
      .map((s) => s.sessionKey),
  );
  for (const session of sessions.filter((s) => !held.has(s.sessionKey)))
    for (const a of (session.verdict.anomalies || []).filter((a) =>
      RULE_TYPES.includes(a.type),
    )) {
      const sourceRef = `rules-v2:${employeeId}:${session.sessionKey}:${a.type}`;
      const fact = { ...a, sessionKey: session.sessionKey };
      desired.set(sourceRef, { ...fact, factHash: hash(json(fact)) });
    }
  let changed = false;
  for (const row of old) {
    // Incomplete or conflicting evidence cannot reverse an already decided case.
    if (
      held.has(row.sessionKey) ||
      sessions.some((s) => s.verdict.status === "SETUP_REQUIRED")
    )
      continue;
    const fact = desired.get(row.sourceRef);
    if (!fact) {
      if (row.evidenceState !== "RESOLVED") {
        await db.attendanceAnomaly.update({
          where: { id: row.id, tenantId, workflowVersion: row.workflowVersion },
          data: {
            evidenceState: "RESOLVED",
            status: "RESOLVED",
            resolvedAt: now,
            workflowVersion: { increment: 1 },
          },
        });
        await db.attendanceRuleAudit.create({
          data: {
            tenantId,
            employeeId: row.employeeId,
            anomalyId: row.id,
            action:
              row.status === "REJECTED" ? "OUTCOME_REVERSED" : "ANOMALY_CLOSED",
            actorId: "attendance-rules",
            data: json({
              before: row,
              reason: "Re-evaluation no longer detects this anomaly",
            }),
          },
        });
        // The case is gone, so a request waiting under it can never be decided.
        await closeRaisedRequest(
          db,
          tenantId,
          row,
          "Re-evaluation closed the case; the request no longer had a source",
        );
        changed = true;
      }
      continue;
    }
    if (row.factHash !== fact.factHash || row.evidenceState === "RESOLVED") {
      await db.attendanceAnomaly.update({
        where: { id: row.id, tenantId, workflowVersion: row.workflowVersion },
        data: {
          expectedTime: fact.expectedTime,
          actualTime: fact.actualTime,
          measuredMinutes: fact.minutes,
          factHash: fact.factHash,
          status: "PENDING",
          evidenceState: "ACTIVE",
          resolvedAt: null,
          decisionRole: null,
          reviewerId: null,
          decidedAt: null,
          reviewNote: null,
          workflowVersion: { increment: 1 },
        },
      });
      await db.attendanceRuleAudit.create({
        data: {
          tenantId,
          employeeId,
          anomalyId: row.id,
          action: "ANOMALY_REVISED",
          actorId: "attendance-rules",
          data: json({ before: row, after: fact }),
        },
      });
      // The evidence changed, so the submitted request's sealed revision is
      // stale. Withdraw it and hand the case back as unraised against the new
      // facts instead of leaving a request every approver click refuses.
      const withdrawn = await closeRaisedRequest(
        db,
        tenantId,
        row,
        "Re-evaluation restated the evidence; the request must be raised again",
      );
      if (withdrawn)
        await db.attendanceAnomaly.update({
          where: { id: row.id, tenantId },
          data: {
            reason: null,
            raisedById: null,
            raisedByName: null,
            workflowVersion: { increment: 1 },
          },
        });
      changed = true;
    }
    desired.delete(row.sourceRef);
  }
  for (const [sourceRef, fact] of desired) {
    const row = await db.attendanceAnomaly.create({
      data: {
        tenantId,
        employeeId,
        date: day,
        sourceKind: "RULES_V2",
        sourceRef,
        rulesVersion: 2,
        sessionKey: fact.sessionKey,
        type: fact.type,
        expectedTime: fact.expectedTime,
        actualTime: fact.actualTime,
        measuredMinutes: fact.minutes,
        factHash: fact.factHash,
        status: "PENDING",
        evidenceState: "ACTIVE",
      },
    });
    await db.attendanceRuleAudit.create({
      data: {
        tenantId,
        employeeId,
        anomalyId: row.id,
        action: "ANOMALY_CREATED",
        actorId: "attendance-rules",
        data: json(fact),
      },
    });
    changed = true;
  }
  if (changed)
    await reconcileRulePayroll(db, { tenantId, employeeId, date: day });
  // Legacy request decisions are retained as history, never reused as a new decision.
  return db.attendanceAnomaly.findMany({
    where: {
      tenantId,
      employeeId,
      date: day,
      rulesVersion: 2,
      evidenceState: "ACTIVE",
    },
  });
}
