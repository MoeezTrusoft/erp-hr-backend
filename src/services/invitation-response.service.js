// src/services/invitation-response.service.js
//
// Recruitment Phase 6 (flag `invitationLinks`) — the candidate answers a talent
// pool invitation through an emailed, single-use link instead of waiting for a
// recruiter to record the answer.
//
//   issueInvitationResponseLink   called by the candidate-communication
//       delivery loop at the moment it sends the invitation email (template
//       talentPool.invitation). Mints a random token, stores ONLY its sha256
//       and expiry on the invitation (responseTokenHash / responseTokenExpires
//       At; the expiry is the invitation's own expiresAt, or 30 days when it
//       has none) and returns the link for the hub call. The raw token goes
//       from here straight into that one email, the same way the DSR
//       verification and the interview slot offer emails carry theirs: it is
//       never in the outbox, the communication row or a log. Minting at send
//       time (not when the invitation is created) is what makes that possible:
//       the event that queues the email is ids-only and is handled in another
//       process, so a token minted earlier could only reach the email by being
//       stored. Each send mints afresh, so a re-sent invitation (the recruiter
//       inviting again while it is open) gets a new link and the old one stops
//       working.
//   getInvitationForCandidate     GET /public/invitations/respond?token= —
//       the role title (and the link's expiry) for a live link, else null.
//   respondViaInvitationLink      POST /public/invitations/respond — the
//       answer goes through talentPoolInvitation.respondToInvitation, the SAME
//       path the recruiter tools use (so accepting a nurture invitation creates
//       the application as it does today), with respondedVia CANDIDATE_LINK and
//       the link's hash, which makes the answer a guarded single-use claim.
//
// No oracle: a malformed, unknown, expired, used or other-tenant token, an
// answered or withdrawn invitation and an erased candidate are all the same
// null. The only distinct refusal is "this role is no longer open" (the
// acceptance was refused by the application intake), which says nothing about
// anyone but the link holder.
import { createHash, randomBytes } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { isInvitationExpired, resolveInvitationResponse } from "../lib/talent-pool-policy.util.js";
import { getRecruitmentSettings } from "./recruitment-settings.service.js";
import { INVITATION_RESPONDED_VIA, respondToInvitation } from "./talent-pool-invitation.service.js";

const log = logger.child({ component: "invitation-response" });

// The careers portal page that renders the answer form (the token alone
// identifies the invitation).
export const PORTAL_INVITATION_RESPONSE_PATH = "/invitations/respond";
export const INVITATION_LINK_DEFAULT_DAYS = 30;
export const INVITATION_NOTE_MAX = 500;
export const INVITATION_ANSWERS = Object.freeze(["ACCEPT", "DECLINE"]);

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const DAY_MS = 24 * 3_600_000;

// Acceptance refusals from the application intake that mean "the role is not
// taking applications": the link holder may be told, nothing else is revealed.
const ROLE_CLOSED_CODES = Object.freeze([
    "HR-RECRUITMENT-APPLICATIONS-CLOSED",
    "HR-RECRUITMENT-REQUISITION-NOT-FOUND",
]);
// Refusals that mean the link is no longer good: the uniform null.
const LINK_GONE_CODES = Object.freeze([
    "HR-RECRUITMENT-INVITATION-LINK-INVALID",
    "HR-RECRUITMENT-INVITATION-TRANSITION-INVALID",
    "HR-RECRUITMENT-INVITATION-NOT-FOUND",
]);

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

export const hashInvitationToken = (token) => createHash("sha256").update(String(token)).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const trimSlash = (value) => String(value ?? "").trim().replace(/\/+$/, "");

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

export function requireInvitationLinksEnabled() {
    if (!isRecruitmentFlagEnabled("invitationLinks")) {
        throw fail("Invitation responses are not available", 503, "HR-RECRUITMENT-INVITATION-LINKS-DISABLED");
    }
}

/** When the link minted at `now` stops working: the invitation's expiry, else 30 days. */
export function invitationLinkExpiry(invitation, now = new Date()) {
    const at = new Date(now);
    const own = invitation?.expiresAt ? new Date(invitation.expiresAt) : null;
    if (own && !Number.isNaN(own.getTime())) return own;
    return new Date(at.getTime() + INVITATION_LINK_DEFAULT_DAYS * DAY_MS);
}

// ── Issuing the link (delivery time) ────────────────────────────────────────

/**
 * Mint the link for one OPEN invitation, under the caller's tenant context.
 *
 * @returns {Promise<{ok: true, url: string, expiresAt: Date, tokenHash: string}
 *                 | {ok: false, reason: string, retry?: boolean}>}
 *          reason: INVITATION_LINKS_DISABLED | NO_PORTAL_URL (retry) | INVITATION_CLOSED
 */
export async function issueInvitationResponseLink({ tenantId, invitationId, now = new Date() } = {}) {
    if (!isRecruitmentFlagEnabled("invitationLinks")) return { ok: false, reason: "INVITATION_LINKS_DISABLED" };
    const id = positiveInt(invitationId);
    if (!tenantId || !id) return { ok: false, reason: "INVITATION_CLOSED" };
    const at = new Date(now);

    const settings = await getRecruitmentSettings({ tenantId });
    const base = trimSlash(settings?.portalBaseUrl || process.env.HR_PORTAL_BASE_URL);
    // Retried by the delivery loop: configuring the portal address fixes it.
    if (!base) return { ok: false, reason: "NO_PORTAL_URL", retry: true };

    const token = newToken();
    const tokenHash = hashInvitationToken(token);
    const issued = await tenantTransaction(
        prisma,
        async (tx) => {
            const invitation = await tx.talentPoolInvitation.findFirst({
                where: withTenant(tenantId, { id }),
                select: { id: true, status: true, expiresAt: true },
            });
            if (!invitation || invitation.status !== "INVITED" || isInvitationExpired(invitation, at)) return null;
            const expiresAt = invitationLinkExpiry(invitation, at);
            // Guarded: an answer or a withdrawal that lands meanwhile wins.
            const claim = await tx.talentPoolInvitation.updateMany({
                where: withTenant(tenantId, { id, status: "INVITED" }),
                data: { responseTokenHash: tokenHash, responseTokenExpiresAt: expiresAt },
            });
            return Number(claim?.count ?? 0) === 1 ? { expiresAt } : null;
        },
        { tenantId },
    );
    if (!issued) return { ok: false, reason: "INVITATION_CLOSED" };
    return {
        ok: true,
        url: `${base}${PORTAL_INVITATION_RESPONSE_PATH}?token=${token}`,
        expiresAt: issued.expiresAt,
        tokenHash,
    };
}

// ── The public link ──────────────────────────────────────────────────────────

/** The live invitation behind a token in the pinned tenant, or null. */
async function findLiveInvitation({ tenantId, token, now }) {
    if (!tenantId || typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const at = new Date(now);
    const tokenHash = hashInvitationToken(token);
    const row = await prisma.talentPoolInvitation.findFirst({
        where: withTenant(tenantId, { responseTokenHash: tokenHash, status: "INVITED", responseTokenExpiresAt: { gt: at } }),
        select: {
            id: true,
            status: true,
            expiresAt: true,
            responseTokenExpiresAt: true,
            candidate: { select: { anonymizedAt: true } },
            jobRequisition: { select: { title: true } },
        },
    });
    if (!row || isInvitationExpired(row, at) || row.candidate?.anonymizedAt) return null;
    return { ...row, tokenHash };
}

/** Validate the answer body. Pure; a malformed body is a 400 before the token is looked at. */
export function parseInvitationAnswer(body = {}) {
    const answer = String(body?.answer ?? "").trim().toUpperCase();
    if (!INVITATION_ANSWERS.includes(answer)) {
        throw fail("answer must be ACCEPT or DECLINE", 400, "HR-RECRUITMENT-INVITATION-RESPONSE-INVALID");
    }
    const raw = body?.note;
    if (raw != null && typeof raw !== "string") {
        throw fail("note must be text", 400, "HR-RECRUITMENT-INVITATION-NOTE-INVALID");
    }
    // Plain text only: markup and control characters are dropped.
    const note = typeof raw === "string"
        ? raw.replace(/<[^>]*>/g, "").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim()
        : "";
    if (note.length > INVITATION_NOTE_MAX) {
        throw fail(`note must be at most ${INVITATION_NOTE_MAX} characters`, 400, "HR-RECRUITMENT-INVITATION-NOTE-INVALID");
    }
    return { response: resolveInvitationResponse(answer), note: note || null };
}

/**
 * The candidate's view of a live link: the role title (null for a general
 * "keep in touch" invitation) and when the link stops working. Null otherwise.
 */
export async function getInvitationForCandidate({ tenantId, token, now = new Date() } = {}) {
    requireInvitationLinksEnabled();
    const live = await findLiveInvitation({ tenantId, token, now });
    if (!live) return null;
    return {
        jobTitle: live.jobRequisition?.title ?? null,
        expiresAt: new Date(live.responseTokenExpiresAt).toISOString(),
    };
}

/**
 * Record the candidate's answer through the link. Returns
 * { answer: "ACCEPTED" | "DECLINED", applicationReceived } or null for every
 * dead link; throws 409 HR-RECRUITMENT-INVITATION-ROLE-CLOSED when the intake
 * refused the acceptance (the invitation stays open and the link live).
 */
export async function respondViaInvitationLink({ tenantId, token, body = {}, now = new Date() } = {}) {
    requireInvitationLinksEnabled();
    const { response, note } = parseInvitationAnswer(body);
    const live = await findLiveInvitation({ tenantId, token, now });
    if (!live) return null;
    let result;
    try {
        result = await respondToInvitation({
            tenantId,
            invitationId: live.id,
            response,
            note,
            via: INVITATION_RESPONDED_VIA.CANDIDATE_LINK,
            tokenHash: live.tokenHash,
        });
    } catch (err) {
        if (LINK_GONE_CODES.includes(err?.code)) return null;
        if (ROLE_CLOSED_CODES.includes(err?.code)) {
            throw fail("This role is no longer open for applications", 409, "HR-RECRUITMENT-INVITATION-ROLE-CLOSED");
        }
        // An outage is an outage (the route answers a generic 500).
        const status = Number(err?.status);
        if (!Number.isInteger(status) || status >= 500) throw err;
        // Any other refusal (do-not-contact, withdrawn consent, ...) is the
        // same dead link on the wire; the reason stays in the log (code only).
        log.warn({ tenantId, invitationId: live.id, code: err?.code ?? null, status }, "invitation link answer refused");
        return null;
    }
    log.info({ tenantId, invitationId: live.id, answer: result?.status }, "invitation answered through the candidate link");
    return {
        answer: result?.status ?? response,
        applicationReceived: Boolean(result?.application?.applicationId),
    };
}

export default {
    issueInvitationResponseLink,
    getInvitationForCandidate,
    respondViaInvitationLink,
};
