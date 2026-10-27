// src/lib/requisitionPublication.js
//
// Phase 4 / decision record §2.4 + §2.4a — the publication vocabulary and its
// validation rules.
//
// Pure functions and frozen vocabularies only (no DB, no I/O). Why not inline in
// the service: publication is reached from REST, from the MCP tools and from the
// legacy /api/hr surface, and a channel list or reason code spread across three
// callers is how "published to LINKEDIN" stops meaning the same thing on each.
//
// The channels are NOT Prisma enums on purpose: adding a job board must not be a
// migration on a table the candidate portal reads, and the decision asks for the
// model to be per-channel now "so LinkedIn/agencies can be added later without a
// schema change". A CHECK constraint in 20260920270000 keeps the database's
// vocabulary in step with this list.

const pubError = (message, code, status = 422) =>
  Object.assign(new Error(message), { status, code });

// ── Publication channels (§2.4) ──────────────────────────────────────────────
//
// MVP is the built-in Career Site plus manually recorded external postings. The
// external ones carry a URL because a "published" posting nobody can reach is not
// a publication — the failure mode this prevents is a recruiter marking a job as
// live on LinkedIn with no link recorded anywhere.
export const PUBLICATION_CHANNELS = Object.freeze([
  "INTERNAL",
  "CAREER_SITE", // the tenant's own careers page — built in, no external URL
  "LINKEDIN",
  "INDEED",
  "AGENCY",
  "REFERRAL",
  "OTHER",
]);

// The channels served by this product itself. Everything else is an external
// system the operator records manually, so it must carry a URL.
export const SELF_HOSTED_CHANNELS = Object.freeze([
  "CAREER_SITE",
  "INTERNAL",
  "REFERRAL",
  "AGENCY",
]);

export const CHANNELS_REQUIRING_URL = Object.freeze(
  PUBLICATION_CHANNELS.filter((channel) => !SELF_HOSTED_CHANNELS.includes(channel)),
);

// ── Posting close reasons (§2.4a) ────────────────────────────────────────────
//
// Coded, because "why did the posting stop" is a report, not prose. OTHER is the
// only value that requires free text (see normalizeCloseReason).
export const POSTING_CLOSE_REASONS = Object.freeze([
  "FILLED", // the opening was filled
  "REQUISITION_CLOSED", // the requisition closed for another reason
  "REQUISITION_WITHDRAWN", // the recruitment was withdrawn
  "REPOSTED", // replaced by a newer posting on the same channel
  "EXPIRED", // channel-side expiry
  "SUPERSEDED_BY_CHANNEL_MODEL", // migration 20260920270000 normalization
  "OTHER",
]);

// ── Requisition withdrawal reasons (§2.4a / FR-01.07) ────────────────────────
//
// Withdrawal is "this recruitment was cancelled before it filled", which is a
// different question from "why did this channel's posting stop" — so it gets its
// own vocabulary rather than reusing the posting reasons.
export const WITHDRAWAL_REASONS = Object.freeze([
  "RECRUITMENT_CANCELLED",
  "POSTED_IN_ERROR",
  "BUDGET_WITHDRAWN",
  "HEADCOUNT_REMOVED",
  "DUPLICATE_REQUISITION",
  "NO_SUITABLE_CANDIDATES",
  "OTHER",
]);

const REASONS_REQUIRING_NOTE = Object.freeze(["OTHER"]);

const isBlank = (value) => value === undefined || value === null || value === "";

const normalizeCode = (value, allowed, field, code) => {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!normalized) {
    throw pubError(`${field} is required`, code, 400);
  }
  if (!allowed.includes(normalized)) {
    throw pubError(`${field} must be one of: ${allowed.join(", ")}`, code);
  }
  return normalized;
};

/**
 * Normalize a close/withdrawal reason and its optional note.
 *
 * A coded reason is mandatory; free text is required ONLY for OTHER, so an
 * "OTHER" withdrawal can never be filed as an unexplained one. The note is
 * trimmed and never used as the reason itself — the code stays the reportable
 * fact.
 */
export function normalizeReason(reason, note, allowed, code, field = "reason") {
  const normalized = normalizeCode(reason, allowed, field, code);
  const trimmedNote = isBlank(note) ? null : String(note).trim();
  if (REASONS_REQUIRING_NOTE.includes(normalized) && !trimmedNote) {
    throw pubError(`${field} OTHER requires a free-text note explaining it`, code);
  }
  return { reason: normalized, note: trimmedNote };
}

export const normalizePostingCloseReason = (reason, note) =>
  normalizeReason(
    reason,
    note,
    POSTING_CLOSE_REASONS,
    "HR-RECRUITMENT-POSTING-CLOSE-REASON-INVALID",
  );

export const normalizeWithdrawalReason = (reason, note) =>
  normalizeReason(reason, note, WITHDRAWAL_REASONS, "HR-RECRUITMENT-WITHDRAWAL-REASON-INVALID");

/**
 * Validate + normalize ONE channel publication request.
 *
 * Accepts the compact string form (`"LINKEDIN"`) as well as an object, because the
 * existing `hr_requisition_post` MCP tool already advertises
 * `postingChannels: string[]` and a caller that sends `["LINKEDIN"]` with a
 * top-level `externalUrl` must keep working.
 *
 * Returns `{ channel, externalUrl, channelRef }` with the URL required for every
 * externally hosted channel.
 */
export function normalizeChannelPublication(input, { externalUrl = null, channelRef = null } = {}) {
  let channel;
  let url = externalUrl;
  let ref = channelRef;

  if (typeof input === "string") {
    channel = input;
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    channel = input.channel ?? input.name;
    if (input.externalUrl !== undefined) url = input.externalUrl;
    if (input.channelRef !== undefined) ref = input.channelRef;
  } else {
    throw pubError(
      "Each publication channel must be a channel name or a { channel, externalUrl } object",
      "HR-RECRUITMENT-PUBLICATION-CHANNEL-INVALID",
    );
  }

  const normalized = normalizeCode(
    channel,
    PUBLICATION_CHANNELS,
    "channel",
    "HR-RECRUITMENT-PUBLICATION-CHANNEL-INVALID",
  );
  const normalizedUrl = isBlank(url) ? null : String(url).trim();

  if (CHANNELS_REQUIRING_URL.includes(normalized) && !normalizedUrl) {
    throw pubError(
      `externalUrl is required when publishing to ${normalized}`,
      "HR-RECRUITMENT-PUBLICATION-URL-REQUIRED",
    );
  }

  if (normalizedUrl) {
    // A recorded "posting URL" of "linkedin" is not a publication anyone can
    // follow, and this value ends up on the candidate-facing page.
    let parsed;
    try {
      parsed = new URL(normalizedUrl);
    } catch {
      throw pubError(
        "externalUrl must be an absolute http(s) URL",
        "HR-RECRUITMENT-PUBLICATION-URL-INVALID",
      );
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw pubError(
        "externalUrl must be an absolute http(s) URL",
        "HR-RECRUITMENT-PUBLICATION-URL-INVALID",
      );
    }
  }

  return {
    channel: normalized,
    externalUrl: normalizedUrl,
    channelRef: isBlank(ref) ? null : String(ref).trim(),
  };
}

/**
 * Normalize the `postingChannels` payload into a deduplicated list.
 *
 * An empty/absent list means "the built-in career site", which is what the
 * pre-channel `POST /post/:id` endpoint effectively did — the difference is that
 * it is now explicit and recorded.
 */
export function normalizeChannelList(
  postingChannels,
  { externalUrl = null, channelRef = null } = {},
) {
  const raw = isBlank(postingChannels)
    ? ["CAREER_SITE"]
    : Array.isArray(postingChannels)
      ? postingChannels
      : [postingChannels];

  if (!raw.length) {
    throw pubError(
      "postingChannels must name at least one channel",
      "HR-RECRUITMENT-PUBLICATION-CHANNEL-INVALID",
    );
  }

  const seen = new Map();
  for (const entry of raw) {
    const normalized = normalizeChannelPublication(entry, { externalUrl, channelRef });
    seen.set(normalized.channel, normalized);
  }
  return [...seen.values()];
}

/**
 * Which statuses may be published from.
 *
 * APPROVED is the first publication (§2.4's workflow: approved → posted); POSTED
 * is an ADDITIONAL channel on an already-published requisition, which is exactly
 * the case the per-channel model exists for. Anything else is refused.
 */
export const PUBLISHABLE_FROM = Object.freeze(["APPROVED", "POSTED"]);

export function assertPublishableStatus(status) {
  const normalized = String(status ?? "")
    .trim()
    .toUpperCase();
  if (!PUBLISHABLE_FROM.includes(normalized)) {
    throw Object.assign(
      new Error(
        `Only an APPROVED or already-POSTED requisition can be published to a channel (current status: ${normalized || "(unknown)"})`,
      ),
      {
        status: 409,
        code: "HR-RECRUITMENT-PUBLICATION-STATUS-INVALID",
        details: { status: normalized, allowedFrom: [...PUBLISHABLE_FROM] },
      },
    );
  }
  return normalized;
}

/**
 * Is this posting accepting applications right now? (Pure; used by the
 * eligibility checks and by the candidate-facing read path.)
 *
 * Both halves matter: `isActive` carries the intent and `closedAt` carries the
 * fact, and the database constrains them to agree — this is the read-side
 * expression of that same rule.
 */
export function isPostingOpen(posting) {
  if (!posting || posting.isActive !== true) return false;
  if (posting.closedAt) return false;
  return true;
}
