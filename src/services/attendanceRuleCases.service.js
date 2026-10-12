import { createHash } from "node:crypto";
import { RULE_TYPES } from "../lib/attendanceAnomalyRules.js";
import { reconcileRulePayroll } from "./attendanceRulePayroll.service.js";
const json = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
            employeeId,
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
