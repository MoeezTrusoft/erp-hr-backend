// Approval stage policy — which stages of the HR Approval Centre are ENGAGED
// for a request kind.
//
// Operator decision (2026-10-27): the Level-1 LINE_MANAGER recommendation is
// PAUSED for attendance anomaly resolutions. A raised resolution request
// therefore lands straight in the HR verification stage — HR verifies the
// evidence against the current fact hash and Management decides.
//
// The stage is paused, not removed:
//   • the engine keeps the full INITIATOR → LINE_MANAGER → HR → MANAGEMENT
//     vocabulary, so nothing downstream has to learn a second shape;
//   • the submission's own HrApprovalAudit row records the jump
//     (fromStage INITIATOR → toStage HR), which is the audit evidence that the
//     manager step was skipped rather than forgotten;
//   • reverting from HR already lands on INITIATOR (HR_REVERT_TARGET), so a
//     return does not strand the request in a stage nobody can act on;
//   • restoring the recommendation is a change to this one table.
//
// A tenant-scoped setting in AttendancePolicyConfig is the intended follow-up;
// this module is the single place that answers the question today.
//
// Only kinds listed here are affected. Every other kind keeps the full route.
const PAUSED_STAGES = Object.freeze({
  ATTENDANCE: Object.freeze(["LINE_MANAGER"]),
});

export const pausedStagesFor = (kind) => PAUSED_STAGES[kind] ?? [];

export const isStagePaused = (kind, stage) =>
  pausedStagesFor(kind).includes(stage);

// The stage a submitted request enters: the first ENGAGED stage after
// INITIATOR. A paused manager stage sends the request to HR instead.
export const stageAfterSubmission = (kind) =>
  isStagePaused(kind, "LINE_MANAGER") ? "HR" : "LINE_MANAGER";

// Whether submission needs an active independent line manager to be configured.
export const requiresLineManager = (kind) => !isStagePaused(kind, "LINE_MANAGER");

// Employee-originated time and money requests do not stop when the employee has no usable line manager (none set, the
// submitter as their own manager, or an inactive manager). They enter HR verification instead, and the submission's audit row
// records the jump. Found 2026-10-31: no Trusoft employee has a manager, so leave could not be submitted at all (HR-4200).
// Performance, goals and the other kinds keep the hard requirement: a review needs an independent reviewer.
const HR_WHEN_NO_MANAGER = Object.freeze([
  "LEAVE",
  "OVERTIME",
  "CLAIM",
  "LOAN",
  "SHIFT_SWAP",
  "TIME_CREDIT",
  "ATTENDANCE_CORRECTION",
]);

export const skipsManagerWhenNone = (kind) => HR_WHEN_NO_MANAGER.includes(kind);

// Operator decision (2026-10-28): a request that HR raises ON BEHALF of an
// employee is HR-verified by the act of raising it. HR has already reviewed the
// day and filed the case, so a second HR verification of the same request would
// be HR approving its own filing. These kinds therefore enter the first stage
// after HR verification (MANAGEMENT) with the verification recorded against the
// filer. The employee's own submission is unaffected and still lands at HR.
const VERIFIED_ON_BEHALF = Object.freeze(["ATTENDANCE"]);

export const isVerifiedOnBehalf = (kind) => VERIFIED_ON_BEHALF.includes(kind);
