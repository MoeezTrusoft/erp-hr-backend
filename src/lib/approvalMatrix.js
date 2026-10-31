// Configurable approval matrix — the pure rules (no database).
//
// ATTENDANCE and PAYROLL each have their own ordered route of levels. A level has one ACTION:
//   RECOMMEND  recommend approval / rejection (a manager-style opinion, the request moves on)
//   VERIFY     verify the request (HR-style check, the request moves on)
//   APPROVE    approve or reject: the decision. Only the LAST level may be APPROVE.
// Who may act is ASSIGNED: named employees, or the subject employee's line manager. The base
// `hr.approvals.*` grant for the action is still required (see PERMISSION_BY_ACTION).
//
// A request seals the published route when it is submitted (`buildRoute`); the engine then walks
// the sealed levels. Requests without a sealed route keep the four fixed stages of
// lib/approvalStagePolicy.js, so nothing in flight changes when a matrix is published.
import { z } from "zod";

export const MATRIX_KINDS = Object.freeze(["ATTENDANCE", "PAYROLL"]);
export const LEVEL_ACTIONS = Object.freeze(["RECOMMEND", "VERIFY", "APPROVE"]);
export const APPROVER_MODES = Object.freeze(["NAMED", "EMPLOYEE_MANAGER"]);
export const MAX_LEVELS = 8;

// The Approval Centre actions a level offers (the vocabulary is shared with the fixed stages).
export const ACTIONS_BY_LEVEL = Object.freeze({
  RECOMMEND: ["RECOMMEND_APPROVAL", "RECOMMEND_REJECTION"],
  VERIFY: ["VERIFY", "REJECT"],
  APPROVE: ["APPROVE", "REJECT"],
});
export const PERMISSION_BY_ACTION = Object.freeze({
  RECOMMEND: "manager",
  VERIFY: "verify",
  APPROVE: "approve",
});

const Level = z
  .object({
    name: z.string().trim().min(1).max(60),
    action: z.enum(LEVEL_ACTIONS),
    required: z.boolean().default(true),
    // A paused level stays in the route but is skipped, exactly like the paused manager stage of
    // the fixed stages. Un-pause it to switch it back on; the last (deciding) level cannot pause.
    paused: z.boolean().default(false),
    approverMode: z.enum(APPROVER_MODES),
    approverIds: z.array(z.number().int().positive()).max(20).default([]),
    canReject: z.boolean().default(true),
    canReturn: z.boolean().default(true),
    satisfiedByInitiator: z.boolean().default(false),
    // The employee a request is about may be the verifier of their own request (a verifier whose
    // own cases have no other verifier). Their raising it then counts as this level. VERIFY only.
    allowSelf: z.boolean().default(false),
    thresholdAmount: z.number().nonnegative().nullable().default(null),
  })
  .strict();
export const MatrixLevels = z.array(Level).min(1).max(MAX_LEVELS);

const bad = (message) => Object.assign(new Error(message), { status: 422 });

export function assertKind(kind) {
  if (!MATRIX_KINDS.includes(kind)) throw bad(`No approval matrix for ${kind}`);
}

// Normalises and validates a route. `kind` decides the optional threshold.
export function parseLevels(kind, raw) {
  assertKind(kind);
  const parsed = MatrixLevels.safeParse(raw);
  if (!parsed.success)
    throw bad(
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "levels"}: ${i.message}`)
        .join("; "),
    );
  const levels = parsed.data.map((l) => ({
    ...l,
    approverIds: [...new Set(l.approverIds)],
  }));
  levels.forEach((l, i) => {
    const at = `Level ${i + 1} (${l.name})`;
    const last = i === levels.length - 1;
    if (l.action === "APPROVE" && !last)
      throw bad(`${at}: only the last level can approve`);
    if (last && l.action !== "APPROVE")
      throw bad(`${at}: the last level must approve`);
    if (last && l.paused) throw bad(`${at}: the deciding level cannot be paused`);
    if (l.approverMode === "NAMED" && !l.approverIds.length && !l.paused)
      throw bad(`${at}: assign at least one approver`);
    if (l.approverMode === "EMPLOYEE_MANAGER" && l.approverIds.length)
      throw bad(`${at}: remove the named approvers or choose named approvers`);
    if (l.allowSelf && l.action !== "VERIFY")
      throw bad(`${at}: only a verification level can allow the employee to verify their own request`);
    if (l.allowSelf && l.approverMode !== "NAMED")
      throw bad(`${at}: choose named approvers to allow self verification`);
    if (l.action === "APPROVE" && l.satisfiedByInitiator)
      throw bad(`${at}: the decision cannot be satisfied by the initiator`);
    if (l.action === "APPROVE" && !l.canReject && !l.canReturn)
      throw bad(`${at}: allow rejecting or returning`);
    if (l.thresholdAmount != null) {
      if (kind !== "PAYROLL") throw bad(`${at}: amount thresholds apply to payroll only`);
      if (l.required) throw bad(`${at}: a required level cannot have a threshold`);
    }
    if (last && !l.required) throw bad(`${at}: the last level is always required`);
  });
  return levels;
}

// The amount compared with a level's threshold (payroll: the run's net total).
export const amountOf = (kind, source) =>
  kind === "PAYROLL" ? Number(source?.row?.totalNet ?? 0) : 0;

const uniq = (codes) => [...new Set(codes.filter(Boolean))];

// Seals a published route for one submission.
//   approvers(level) -> employee codes the level could use (already active people)
//   initiator        -> code of the submitter; subject -> code of the employee the request is about.
//                       Neither may approve the request.
// Throws when a required level has nobody left to act.
export function buildRoute({ kind, matrixVersion, levels, initiator, subject, amount, approvers }) {
  const sealed = levels.map((l, i) => {
    const at = `Level ${i + 1} (${l.name})`;
    if (l.paused)
      return {
        index: i, name: l.name, action: l.action, required: l.required, paused: true,
        canReject: l.canReject, canReturn: l.canReturn, approverCodes: [],
        viaManager: l.approverMode === "EMPLOYEE_MANAGER", engaged: false, auto: false, skipped: "PAUSED",
      };
    const assigned = uniq(approvers(l));
    const eligible = l.allowSelf ? assigned : assigned.filter((c) => c !== initiator && c !== subject);
    const out = {
      index: i,
      name: l.name,
      action: l.action,
      required: l.required,
      canReject: l.canReject,
      canReturn: l.canReturn,
      allowSelf: l.allowSelf,
      approverCodes: eligible,
      viaManager: l.approverMode === "EMPLOYEE_MANAGER",
      engaged: true,
      auto: false,
      skipped: null,
    };
    if (l.thresholdAmount != null && amount < l.thresholdAmount)
      return { ...out, engaged: false, skipped: "BELOW_THRESHOLD" };
    // HR raising the request is the HR verification: the level is done by the initiator. Payroll is
    // always raised by the person it was processed by; for any other kind the raiser must be someone
    // other than the employee the request is about (nobody verifies their own case).
    if (
      (l.satisfiedByInitiator || (l.allowSelf && initiator === subject)) &&
      l.action !== "APPROVE" &&
      assigned.includes(initiator) &&
      (kind === "PAYROLL" || initiator !== subject || l.allowSelf)
    )
      return { ...out, auto: true };
    if (!eligible.length) {
      if (l.required)
        throw bad(`${at} has no active approver other than the initiator. Ask an administrator to update the approval matrix`);
      return { ...out, engaged: false, skipped: "NO_APPROVER" };
    }
    return out;
  });
  const decision = sealed.at(-1);
  if (!decision.engaged || decision.action !== "APPROVE")
    throw bad("The approval matrix has no deciding level");
  return { kind, matrixVersion, levels: sealed, acted: [] };
}

// Index of the first level at or after `from` that still needs somebody to act.
export function nextActionable(route, from, actedCodes = []) {
  for (let i = from; i < route.levels.length; i += 1) {
    const l = route.levels[i];
    if (!l.engaged || l.auto) continue;
    const eligible = l.approverCodes.filter((c) => !actedCodes.includes(c));
    if (eligible.length) return { index: i, codes: eligible };
    if (l.required)
      throw bad(`${l.name}: everyone assigned to this level has already acted on this request. Ask an administrator to add another approver`);
  }
  return null;
}

// The previous level a REVERT returns to; null = back to the initiator.
export function previousActionable(route, from) {
  for (let i = from - 1; i >= 0; i -= 1) {
    const l = route.levels[i];
    if (l.engaged && !l.auto) return i;
  }
  return null;
}

// Actions the person at `level` may perform (before identity checks).
export function levelActions(level) {
  const actions = [...ACTIONS_BY_LEVEL[level.action]];
  const filtered = actions.filter((a) => {
    if (level.action === "RECOMMEND" && a === "RECOMMEND_REJECTION") return level.canReject;
    if ((level.action === "APPROVE" || level.action === "VERIFY") && a === "REJECT") return level.canReject;
    return true;
  });
  return level.canReturn ? [...filtered, "REVERT"] : filtered;
}

// How a waiting request reads on screens that only show a stage ("Awaiting HR verification").
export const levelStageLabel = (route, level) =>
  route?.levels?.[level] ? `Awaiting ${route.levels[level].name}` : null;
