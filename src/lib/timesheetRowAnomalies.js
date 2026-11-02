// TS-MULTI-ANOM-01 (2026-10-28) — a day can hold several detected cases (a late
// check-in AND a missing check-out), and each is raised and decided on its own.
// The Timesheet row used to carry only ONE of them; this lists every active
// rules-v2 case of the employee-day, each with its own request state, so the
// table can show them all and the raise action can address one.
import { levelStageLabel } from "./approvalMatrix.js";
import { RULE_TYPES } from "./attendanceAnomalyRules.js";

const FORM_SOURCES = ["REGULARIZATION", "PAPER_FORM"];

// Most severe first, the order the status cell reads in.
const ORDER = ["ABSENT", "MISSING_CHECKIN", "MISSING_CHECKOUT", "LATE_CHECKIN", "EARLY_CHECKOUT"];

/** Active rules-v2 cases of one employee-day, as the row carries them. */
export function rowAnomalies(dayAnomalies = [], { approvalByAnomaly, decisionsByAnomaly, raiseByByAnomaly } = {}) {
  return dayAnomalies
    .filter(
      (an) =>
        RULE_TYPES.includes(an.type) &&
        Number(an.rulesVersion) === 2 &&
        an.evidenceState !== "SUPERSEDED" &&
        an.evidenceState !== "RESOLVED" &&
        !FORM_SOURCES.includes(String(an.sourceKind ?? "").toUpperCase()),
    )
    .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.id - b.id)
    .map((an) => {
      const approval = approvalByAnomaly?.get(String(an.id)) ?? null;
      return {
        id: an.id,
        type: an.type,
        expectedTime: an.expectedTime ?? null,
        actualTime: an.actualTime ?? null,
        // UNSUBMITTED until a resolution request exists for this exact case.
        request: approval
          ? {
              anomalyId: an.id,
              status: an.status,
              stage: approval.stage ?? null,
              stageLabel: levelStageLabel(approval.route, approval.level),
              approvalRef: approval.id ?? null,
              type: an.type,
              submittedAt: an.createdAt,
              decidedAt: an.decidedAt,
              raisedById: an.raisedById ?? null,
              raisedByName: an.raisedByName ?? null,
              reason: an.reason,
              reviewNote: an.reviewNote,
              expectedTime: an.expectedTime,
              actualTime: an.actualTime,
              decisions: decisionsByAnomaly?.get(an.id) ?? [],
            }
          : { status: "UNSUBMITTED", anomalyId: an.id, type: an.type, raiseBy: raiseByByAnomaly?.get(an.id) ?? null },
      };
    });
}
