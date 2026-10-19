// src/lib/talentPoolPolicy.js — FR-10 residue.
//
// PURE talent-pool decisions: the invitation LIFECYCLE and the SEGMENTATION
// predicates. No DB, no I/O, so the whole matrix is unit-testable and cannot
// drift between the service, the tools and the sweep.
//
// Why an explicit lifecycle at all: until now "invited to apply" was a free-text
// note appended to a row. A note cannot answer the questions the process actually
// asks — does this candidate have an open invitation, did they answer, has it
// lapsed — so nobody could tell a live invitation from last quarter's. The states
// are therefore closed and the transitions one-way: an invitation that has been
// answered is history, and history is appended, never rewritten.
const fail = (message, code) => Object.assign(new Error(message), { status: 422, code });

/** The closed invitation vocabulary. */
export const INVITATION_STATUSES = Object.freeze([
  "INVITED",
  "ACCEPTED",
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
]);

/** Terminal states: an answered or lapsed invitation never moves again. */
export const INVITATION_TERMINAL_STATUSES = Object.freeze([
  "ACCEPTED",
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
]);

/**
 * The ONE-WAY transition map. INVITED is the only non-terminal state, so re-racing
 * an answered invitation is a refusal rather than a silent overwrite — the whole
 * point of tracking the status is that the answer is not negotiable after the
 * fact. A change of mind is a NEW invitation.
 */
export const INVITATION_TRANSITIONS = Object.freeze({
  INVITED: Object.freeze(["ACCEPTED", "DECLINED", "WITHDRAWN", "EXPIRED"]),
  ACCEPTED: Object.freeze([]),
  DECLINED: Object.freeze([]),
  WITHDRAWN: Object.freeze([]),
  EXPIRED: Object.freeze([]),
});

/** How long an unanswered invitation stays live. */
export const DEFAULT_INVITATION_VALIDITY_DAYS = 30;
const MAX_INVITATION_VALIDITY_DAYS = 365;

export const isInvitationTerminal = (status) => INVITATION_TERMINAL_STATUSES.includes(status);

/** The candidate's answer, normalized to the two states a response may reach. */
export const resolveInvitationResponse = (response) => {
  const normalized = String(response ?? "").trim().toUpperCase();
  if (normalized === "ACCEPT" || normalized === "ACCEPTED") return "ACCEPTED";
  if (normalized === "DECLINE" || normalized === "DECLINED") return "DECLINED";
  throw fail(
    `Invitation response must be ACCEPTED or DECLINED (received "${response ?? ""}")`,
    "HR-RECRUITMENT-INVITATION-RESPONSE-INVALID",
  );
};

/**
 * When an invitation created at `invitedAt` lapses.
 *
 * A lapsed invitation is NOT a rejection: it records that the candidate never
 * answered, which is the fact a recruiter needs before re-inviting.
 */
export const invitationExpiry = ({ invitedAt = new Date(), validityDays = DEFAULT_INVITATION_VALIDITY_DAYS } = {}) => {
  const days = validityDays === null || validityDays === undefined || validityDays === ""
    ? DEFAULT_INVITATION_VALIDITY_DAYS
    : Number(validityDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_INVITATION_VALIDITY_DAYS) {
    throw fail(
      `validityDays must be a whole number between 1 and ${MAX_INVITATION_VALIDITY_DAYS}`,
      "HR-RECRUITMENT-INVITATION-VALIDITY-INVALID",
    );
  }
  const out = new Date(invitedAt);
  out.setDate(out.getDate() + days);
  return out;
};

/** An INVITED row whose expiry has passed. Terminal rows are never "expired". */
export const isInvitationExpired = (invitation, asOf = new Date()) => {
  if (!invitation) return false;
  if (String(invitation.status || "").toUpperCase() !== "INVITED") return false;
  if (!invitation.expiresAt) return false;
  return new Date(invitation.expiresAt) <= new Date(asOf);
};

/** Whether `to` is a legal move from `from`. Returns a reason instead of throwing. */
export const checkInvitationTransition = (from, to) => {
  const fromStatus = String(from ?? "").trim().toUpperCase();
  const toStatus = String(to ?? "").trim().toUpperCase();
  if (!INVITATION_STATUSES.includes(fromStatus)) {
    return { ok: false, error: `Unknown invitation status "${from}"`, code: "HR-RECRUITMENT-INVITATION-STATUS-INVALID" };
  }
  if (!INVITATION_STATUSES.includes(toStatus)) {
    return { ok: false, error: `Unknown invitation status "${to}"`, code: "HR-RECRUITMENT-INVITATION-STATUS-INVALID" };
  }
  const allowed = INVITATION_TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    return {
      ok: false,
      error: `An invitation in status ${fromStatus} cannot become ${toStatus}`,
      code: "HR-RECRUITMENT-INVITATION-TRANSITION-INVALID",
    };
  }
  return { ok: true };
};

// ── Segmentation ────────────────────────────────────────────────────────────

/**
 * The closed segmentation vocabulary. Closed on purpose: an unknown key would be
 * silently ignored, and "I filtered by skill and got everyone" is worse than a
 * rejected request.
 */
export const SEGMENT_KEYS = Object.freeze([
  "poolNames",
  "skills",
  "locations",
  "sources",
  "minExperienceYears",
  "maxExperienceYears",
  "invitedWithinDays",
  "hasOpenInvitation",
]);

const normalizeText = (value) => String(value ?? "").trim().toLowerCase();
const toStringList = (value, label) => {
  if (value === undefined || value === null) return null;
  const list = Array.isArray(value) ? value : [value];
  const cleaned = list.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0);
  if (cleaned.length === 0) throw fail(`${label} must name at least one value`, "HR-RECRUITMENT-SEGMENT-EMPTY");
  return cleaned;
};

/**
 * Validate a segment request.
 *
 * @returns {{ok: true, filters: object} | {ok: false, error: string}}
 */
export const validateSegment = (filters) => {
  try {
    if (filters === undefined || filters === null) return { ok: true, filters: {} };
    if (typeof filters !== "object" || Array.isArray(filters)) {
      return { ok: false, error: "Segment filters must be an object", code: "HR-RECRUITMENT-SEGMENT-INVALID" };
    }
    const unknown = Object.keys(filters).filter((key) => !SEGMENT_KEYS.includes(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `Unknown segment filter(s): ${unknown.join(", ")}. Allowed: ${SEGMENT_KEYS.join(", ")}`,
        code: "HR-RECRUITMENT-SEGMENT-KEY-INVALID",
      };
    }

    const number = (value, label, { integer = false } = {}) => {
      if (value === undefined || value === null || value === "") return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
        throw fail(`${label} must be a ${integer ? "whole " : ""}number >= 0`, "HR-RECRUITMENT-SEGMENT-NUMBER-INVALID");
      }
      return n;
    };

    const minExperienceYears = number(filters.minExperienceYears, "minExperienceYears");
    const maxExperienceYears = number(filters.maxExperienceYears, "maxExperienceYears");
    if (minExperienceYears != null && maxExperienceYears != null && minExperienceYears > maxExperienceYears) {
      throw fail("minExperienceYears must not exceed maxExperienceYears", "HR-RECRUITMENT-SEGMENT-RANGE-INVALID");
    }

    const hasOpenInvitation = filters.hasOpenInvitation === undefined || filters.hasOpenInvitation === null
      ? null
      : Boolean(filters.hasOpenInvitation);

    return {
      ok: true,
      filters: {
        poolNames: toStringList(filters.poolNames, "poolNames"),
        skills: toStringList(filters.skills, "skills"),
        locations: toStringList(filters.locations, "locations"),
        sources: toStringList(filters.sources, "sources"),
        minExperienceYears,
        maxExperienceYears,
        invitedWithinDays: number(filters.invitedWithinDays, "invitedWithinDays", { integer: true }),
        hasOpenInvitation,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
};

/**
 * Whether one candidate row matches a validated segment.
 *
 * The row is the SERVICE's projection (see talentPoolSegmentation in the
 * service) — pool names, normalized skill names, location, source, derived
 * experience, last-contact date and open-invitation state. Keeping the predicate
 * here means the MCP tool, the REST route and any future export agree by
 * construction.
 */
export const matchesSegment = (row, filters = {}) => {
  const anyOf = (list, value) => (list || []).some((needle) => normalizeText(needle) === normalizeText(value));

  if (filters.poolNames && !(row.poolNames || []).some((name) => anyOf(filters.poolNames, name))) return false;
  // Skills are ANY-of: a candidate who has one of the requested skills is in the
  // segment. Requiring all of them would turn a filter into a wish list.
  if (filters.skills && !(row.skillNames || []).some((name) => anyOf(filters.skills, name))) return false;
  if (filters.locations) {
    const location = normalizeText(row.location);
    if (!location || !filters.locations.some((needle) => location.includes(normalizeText(needle)))) return false;
  }
  if (filters.sources && !anyOf(filters.sources, row.source)) return false;
  if (filters.minExperienceYears != null && !(Number(row.experienceYears) >= filters.minExperienceYears)) return false;
  if (filters.maxExperienceYears != null && !(Number(row.experienceYears) <= filters.maxExperienceYears)) return false;
  if (filters.hasOpenInvitation != null && Boolean(row.hasOpenInvitation) !== filters.hasOpenInvitation) return false;
  if (filters.invitedWithinDays != null) {
    // "invited recently" needs a date; a candidate never invited is not recent.
    if (!row.lastInvitedAt) return false;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - filters.invitedWithinDays);
    if (new Date(row.lastInvitedAt) < cutoff) return false;
  }
  return true;
};

/**
 * The reasons one candidate fell out of a segment.
 *
 * A count alone is not actionable ("why is this pool smaller than yesterday?"),
 * so the filters that rejected a row are named, in the same order
 * `matchesSegment` applies them. The caller attributes the shortfall to the
 * FIRST named reason (a row can fail several, but the operator only needs the
 * one to fix next).
 */
export const segmentRejectionReasons = (row, filters = {}) => {
  const reasons = [];
  const anyOf = (list, value) => (list || []).some((needle) => normalizeText(needle) === normalizeText(value));

  if (filters.poolNames && !(row.poolNames || []).some((name) => anyOf(filters.poolNames, name))) reasons.push("pool");
  if (filters.skills && !(row.skillNames || []).some((name) => anyOf(filters.skills, name))) reasons.push("skills");
  if (filters.locations) {
    const location = normalizeText(row.location);
    if (!location || !filters.locations.some((needle) => location.includes(normalizeText(needle)))) reasons.push("location");
  }
  if (filters.sources && !anyOf(filters.sources, row.source)) reasons.push("source");
  if (filters.minExperienceYears != null && !(Number(row.experienceYears) >= filters.minExperienceYears)) reasons.push("experience");
  if (filters.maxExperienceYears != null && !(Number(row.experienceYears) <= filters.maxExperienceYears)) reasons.push("experience");
  if (filters.hasOpenInvitation != null && Boolean(row.hasOpenInvitation) !== filters.hasOpenInvitation) reasons.push("invitation");
  if (filters.invitedWithinDays != null) {
    if (!row.lastInvitedAt) reasons.push("invitedWithinDays");
    else {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - filters.invitedWithinDays);
      if (new Date(row.lastInvitedAt) < cutoff) reasons.push("invitedWithinDays");
    }
  }
  return reasons;
};
