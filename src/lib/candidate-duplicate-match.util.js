// src/lib/candidate-duplicate-match.util.js
//
// Recruitment Phase 2 — duplicate candidate detection, the PURE half.
//
// Candidate email is unique per tenant, so a duplicate identity almost never
// shares the stored email byte for byte. It hides behind spelling variants of
// the same mailbox (case, whitespace, a +tag, gmail's dot-insensitivity), behind
// phone formatting (+92 300 1234567 vs 03001234567), or behind the same resume
// uploaded twice. This module turns two candidate rows into a score and a set of
// BOOLEAN signals; the service decides which rows to compare and what to store.
//
// Two rules the stored suggestion depends on:
//   * signals are booleans only. The suggestion row is read by people who may
//     not open either candidate, so it must never carry the matched value
//     (schema comment on CandidateDuplicateSuggestion.signals);
//   * a name on its own never suggests a merge. Two people can share a name;
//     they rarely share a name AND a phone.
//
// No DB, no I/O: everything here is unit-tested directly.

/** Minimum score at which a pair becomes a suggestion. */
export const DUPLICATE_SUGGESTION_THRESHOLD = 60;

// Single-signal weights. The strongest signal sets the base score; each extra
// strong signal adds a little, and a matching name adds more because it turns
// "same phone" into "same person".
export const SIGNAL_WEIGHTS = Object.freeze({
    email: 90,
    profileUrl: 80,
    resumeHash: 80,
    phone: 70,
});
const NAME_ONLY_SCORE = 30; // informative, always below the threshold
const NAME_BONUS = 15; // phone 70 + name 15 = 85
const EXTRA_SIGNAL_BONUS = 5;

// Stages after which an application no longer competes for the seat. Same set
// candidateMerge.service.js uses for its live-overlap refusal.
const TERMINAL_STAGES = new Set(["hired", "rejected", "withdrawn"]);

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// Profile hosts whose path is a stable personal identifier.
const PROFILE_HOSTS = Object.freeze({
    "linkedin.com": /^\/in\/[^/]+/,
    "github.com": /^\/[^/]+/,
});

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Canonical mailbox key: lowercase, trimmed, +tag removed, gmail/googlemail
 * folded together with dots ignored.
 * @returns {{ local: string, domain: string, key: string } | null}
 */
export function normalizeEmailKey(email) {
    const raw = text(email).toLowerCase();
    const at = raw.lastIndexOf("@");
    if (at <= 0 || at === raw.length - 1) return null;
    let local = raw.slice(0, at);
    let domain = raw.slice(at + 1);
    const plus = local.indexOf("+");
    if (plus === 0) return null;
    if (plus > 0) local = local.slice(0, plus);
    if (GMAIL_DOMAINS.has(domain)) {
        domain = "gmail.com";
        local = local.replace(/\./g, "");
    }
    if (!local) return null;
    return { local, domain, key: `${local}@${domain}` };
}

/**
 * Phone key: digits only; the last 10 digits when there are at least 10 (so a
 * country code or a trunk 0 does not matter); null below 7 digits (an
 * extension or a typo is not an identity).
 */
export function normalizePhoneKey(phone) {
    const digits = String(phone ?? "").replace(/\D/g, "");
    if (digits.length < 7) return null;
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Name: lowercase, diacritics and punctuation stripped, spaces collapsed. */
export function normalizeName(...parts) {
    const joined = parts.map(text).filter(Boolean).join(" ");
    return joined
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

// "Jean Luc" and "Jean-Luc" (-> "jeanluc") are the same name; compare without spaces.
const nameKey = (candidate) => {
    const key = normalizeName(candidate?.firstName, candidate?.lastName).replace(/ /g, "");
    return key.length >= 3 ? key : null;
};

/** host/path key for a LinkedIn or GitHub profile URL, else null. */
export function normalizeProfileUrl(url) {
    const raw = text(url).toLowerCase();
    if (!raw) return null;
    const withoutScheme = raw.replace(/^[a-z]+:\/\//, "");
    const [hostPart, ...rest] = withoutScheme.split("/");
    const host = hostPart.replace(/^(www|m)\./, "");
    const pattern = PROFILE_HOSTS[host];
    if (!pattern) return null;
    const path = `/${rest.join("/")}`.split(/[?#]/)[0].replace(/\/+$/, "");
    const match = path.match(pattern);
    return match ? `${host}${match[0]}` : null;
}

/**
 * Profile keys carried by a parsed resume. The parser's snapshot today holds
 * skills, competencies, certifications and the content hash; the fields read
 * here are the ones a richer parse may add, read defensively.
 */
export function profileKeysOf(parsedResume) {
    const p = parsedResume && typeof parsedResume === "object" ? parsedResume : {};
    const urls = [p.profileUrl, p.linkedinUrl, p.linkedin, p.githubUrl, p.contact?.linkedin, p.contact?.github];
    if (Array.isArray(p.links)) {
        for (const link of p.links) urls.push(typeof link === "string" ? link : link?.url);
    }
    return new Set(urls.map(normalizeProfileUrl).filter(Boolean));
}

/** The parsed resume's content hash (same file uploaded twice), else null. */
export function resumeHashOf(parsedResume) {
    const hash = parsedResume && typeof parsedResume === "object" ? text(parsedResume.contentHash) : "";
    return hash || null;
}

const sameKey = (a, b) => a != null && b != null && a === b;

/** The BOOLEAN signals for a pair. Never values. */
export function pairSignals(a, b) {
    const profilesA = profileKeysOf(a?.parsedResume);
    const profilesB = profileKeysOf(b?.parsedResume);
    return {
        emailMatch: sameKey(normalizeEmailKey(a?.email)?.key, normalizeEmailKey(b?.email)?.key),
        phoneMatch: sameKey(normalizePhoneKey(a?.phone), normalizePhoneKey(b?.phone)),
        nameMatch: sameKey(nameKey(a), nameKey(b)),
        profileUrlMatch: [...profilesA].some((key) => profilesB.has(key)),
        resumeHashMatch: sameKey(resumeHashOf(a?.parsedResume), resumeHashOf(b?.parsedResume)),
    };
}

/** Score 0-100 from the signals (see SIGNAL_WEIGHTS). */
export function scoreSignals(signals) {
    const strong = [
        signals.emailMatch && SIGNAL_WEIGHTS.email,
        signals.profileUrlMatch && SIGNAL_WEIGHTS.profileUrl,
        signals.resumeHashMatch && SIGNAL_WEIGHTS.resumeHash,
        signals.phoneMatch && SIGNAL_WEIGHTS.phone,
    ].filter(Boolean).sort((x, y) => y - x);
    if (!strong.length) return signals.nameMatch ? NAME_ONLY_SCORE : 0;
    const score = strong[0] + (strong.length - 1) * EXTRA_SIGNAL_BONUS + (signals.nameMatch ? NAME_BONUS : 0);
    return Math.min(100, score);
}

const isLive = (application) => !TERMINAL_STAGES.has(String(application?.stage ?? "").toLowerCase());

/**
 * What a reviewer must see before merging. Each entry says whether it BLOCKS a
 * merge (anonymized, legal hold: candidateMerge.service refuses both) or only
 * needs a decision (a live application to the same requisition on both rows,
 * different consent states, an inactive row that can only be the survivor).
 * Ids and codes only.
 *
 * a/b: { id, status, anonymizedAt, consentStatus, legalHold?: boolean,
 *        applications?: [{ jobRequisitionId, stage }] }
 */
export function pairConflicts(a, b) {
    const conflicts = [];
    const both = [a, b];
    const ids = (pred) => both.filter(pred).map((c) => c.id);

    const anonymized = ids((c) => c?.anonymizedAt);
    if (anonymized.length) conflicts.push({ code: "ANONYMIZED", blocksMerge: true, candidateIds: anonymized });

    const held = ids((c) => c?.legalHold === true);
    if (held.length) conflicts.push({ code: "LEGAL_HOLD", blocksMerge: true, candidateIds: held });

    const liveReqsA = new Set((a?.applications ?? []).filter(isLive).map((app) => app.jobRequisitionId));
    const shared = [...new Set((b?.applications ?? []).filter(isLive).map((app) => app.jobRequisitionId))]
        .filter((reqId) => liveReqsA.has(reqId))
        .sort((x, y) => x - y);
    if (shared.length) conflicts.push({ code: "SHARED_ACTIVE_REQUISITION", blocksMerge: false, requisitionIds: shared });

    if ((a?.consentStatus ?? "UNKNOWN") !== (b?.consentStatus ?? "UNKNOWN")) {
        conflicts.push({ code: "CONSENT_MISMATCH", blocksMerge: false });
    }

    const inactive = ids((c) => c?.status && c.status !== "active");
    if (inactive.length) conflicts.push({ code: "INACTIVE_CANDIDATE", blocksMerge: false, candidateIds: inactive });

    return conflicts;
}

/**
 * Score one pair.
 * @returns {{ score: number, signals: object, conflicts: object[], suggest: boolean }}
 *   suggest is false below the threshold and whenever either row is anonymized
 *   or under legal hold (erasure evidence and held records are never proposed).
 */
export function scorePair(a, b) {
    const signals = pairSignals(a, b);
    const score = scoreSignals(signals);
    const conflicts = pairConflicts(a, b);
    const excluded = conflicts.some((c) => c.code === "ANONYMIZED" || c.code === "LEGAL_HOLD");
    return { score, signals, conflicts, suggest: score >= DUPLICATE_SUGGESTION_THRESHOLD && !excluded };
}

/** The stored pair order: candidateAId < candidateBId (migration CHECK). */
export function orderedPair(idX, idY) {
    const x = Number(idX);
    const y = Number(idY);
    return x < y ? { candidateAId: x, candidateBId: y } : { candidateAId: y, candidateBId: x };
}
