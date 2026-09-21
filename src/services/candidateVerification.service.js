// src/services/candidateVerification.service.js
//
// Phase 5 / decision record §3.2 (email magic links) + §3.4 second half (the
// mailbox-owner notice) — the candidate-facing EMAIL story.
//
// Ownership split the decision record names: the HUB owns email delivery; HR
// owns the token lifecycle and the candidate state. The raw token exists only
// inside the email body — the row stores sha256(token), so a DB leak yields
// hashes, not usable links.
//
// ANTI-ENUMERATION (§3.4 applied to this surface):
//   * consumeToken's failure shape is IDENTICAL for unknown/expired/used/wrong
//     candidate — one generic message, one 400 code, no hint at which failed.
//   * notifyMailboxOwner is fire-and-forget from intake and NEVER changes the
//     intake's byte-identical new/existing response.
import crypto from "node:crypto";
import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { sendCandidateEmail } from "../lib/notificationClient.js";
import { recordRecruitmentNotification } from "../lib/recruitmentOpsMetrics.js";
import logger from "../lib/logger.js";

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24h — long enough for a busy applicant

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

const newToken = () => crypto.randomBytes(32).toString("base64url");

export const EMAIL_VERIFICATION_PURPOSES = Object.freeze(["APPLY_VERIFICATION"]);

export const PORTAL_VERIFY_PATH = "/public/candidates/verify-email";

/**
 * §3.2 — mint a verification token for the candidate's email. TX-SCOPED and
 * HTTP-FREE: this ONLY writes the token row (inside the caller's transaction,
 * so the token joins the application write atomically); the email itself is
 * sent by `sendVerificationEmail` AFTER the transaction commits — an outbound
 * HTTP call must never hold a DB transaction open.
 *
 * Re-issue semantics: one row per candidate+purpose — an existing UNCONSUMED
 * token is replaced (the previous link dies), a CONSUMED row is left as the
 * audit and a fresh row is created. A candidate who re-applies gets a fresh,
 * working link every time.
 *
 * @returns {Promise<null | {candidateId: number, email: string, firstName: string, token: string}>}
 *          null when there is nothing to verify against (no candidate/email).
 */
export const issueEmailVerification = async (tx, { tenantId, candidate, email, now = new Date() }) => {
    const address = email ?? candidate?.email;
    if (!address || !candidate?.id) return null;

    // Replace-then-issue: the candidate's newest link is the only live one.
    await tx.candidateEmailVerification.updateMany({
        where: scopedWhere(tenantId, {
            candidateId: candidate.id,
            purpose: "APPLY_VERIFICATION",
            consumedAt: null,
        }),
        data: { consumedAt: now },
    });

    const token = newToken();
    await tx.candidateEmailVerification.create({
        data: scopedData(tenantId, {
            candidateId: candidate.id,
            email: address,
            tokenHash: hashToken(token),
            purpose: "APPLY_VERIFICATION",
            expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
        }),
    });

    return { candidateId: candidate.id, email: address, firstName: candidate.firstName ?? "", token };
};

/**
 * §3.2 — send the magic-link email for a token issued by `issueEmailVerification`.
 * Call AFTER the issuing transaction commits. Fire-and-forget: a hub outage
 * records `dropped-error` and returns { sent:false } — the row still exists, so
 * the candidate can re-request; no submission ever fails on email.
 */
export const sendVerificationEmail = async ({ tenantId, email, firstName, token }) => {
    if (!token || !email || !tenantId) {
        recordRecruitmentNotification("email_verification", "dropped-error");
        return { sent: false, reason: "missing-token-or-address" };
    }
    const base = process.env.HR_PORTAL_BASE_URL || "";
    const link = `${base}${PORTAL_VERIFY_PATH}?token=${token}`;
    const result = await sendCandidateEmail({
        tenantId,
        email,
        templateId: "hr.recruitment.portal_email_verification",
        data: { firstName, verifyUrl: link, expiresInHours: 24 },
    });
    recordRecruitmentNotification("email_verification", result.sent ? "enqueued" : "dropped-error");
    return result;
};

/**
 * §3.2 — consume a presented token: prove the mailbox owner saw the mail and
 * stamp `candidates.emailVerifiedAt`.
 *
 * UNIFORM FAILURE (§3.4, no-oracle): unknown token, expired, already consumed
 * and candidate-mismatch are the SAME 400 with the SAME body — the endpoint
 * cannot be probed for which emails exist or which links are live.
 */
export const consumeEmailVerification = async ({ token, now = new Date() } = {}) => {
    const trimmed = String(token ?? "").trim();
    if (!trimmed) {
        throw fail("This verification link is not valid", 400, "HR-PORTAL-VERIFY-INVALID");
    }
    const row = await prisma.candidateEmailVerification.findUnique({
        where: { tokenHash: hashToken(trimmed) },
    });
    const usable =
        row &&
        !row.consumedAt &&
        row.expiresAt.getTime() > now.getTime();
    if (!usable) {
        // One shape for every failure; log the class server-side only.
        logger.warn({ tokenClass: row ? (row.consumedAt ? "consumed" : "expired") : "unknown" }, "portal email verify refused");
        throw fail("This verification link is not valid", 400, "HR-PORTAL-VERIFY-INVALID");
    }

    // The stamp + the consume commit together: a replayed token can never stamp
    // twice, and a crashed write cannot leave a verified state with a live link.
    const updated = await tenantTransaction(prisma, async (tx) => {
        const target = await tx.candidateEmailVerification.findUnique({
            where: { tokenHash: row.tokenHash },
        });
        if (!target || target.consumedAt || target.expiresAt.getTime() <= now.getTime()) {
            throw fail("This verification link is not valid", 400, "HR-PORTAL-VERIFY-INVALID");
        }
        await tx.candidateEmailVerification.update({
            where: { id: target.id },
            data: { consumedAt: now },
        });
        // The verification proves the EMAIL, so the stamp follows the address,
        // not the row that happened to carry it — but candidates are keyed by
        // (tenant, email) uniquely, so stamping the owning candidate is exact.
        return tx.candidate.update({
            where: { id: target.candidateId },
            data: { emailVerifiedAt: now, version: { increment: 1 } },
        });
    }, { tenantId: row.tenantId ?? undefined });

    return {
        verified: true,
        candidateId: updated.id,
        email: row.email,
    };
};

/**
 * §3.4 second half — tell the mailbox owner someone applied with their address.
 *
 * Sent ONLY on the RECONCILED path: a brand-new candidate IS the submitter, so
 * a notice would be noise; an existing row means the address predates this
 * application and the owner deserves to know it was used.
 *
 * Fire-and-forget: never throws, never alters the intake's response.
 */
export const notifyMailboxOwner = async ({ tenantId, candidate, requisitionTitle }) => {
    try {
        const result = await sendCandidateEmail({
            tenantId,
            email: candidate.email,
            templateId: "hr.recruitment.portal_mailbox_notice",
            data: {
                firstName: candidate.firstName ?? "",
                jobTitle: requisitionTitle ?? "a position",
            },
            category: "hr.recruitment.mailbox_notice",
        });
        recordRecruitmentNotification("mailbox_notice", result.sent ? "enqueued" : "dropped-error");
        return result;
    } catch (err) {
        recordRecruitmentNotification("mailbox_notice", "dropped-error");
        logger.warn({ err: err?.message }, "mailbox-owner notice failed");
        return { sent: false, reason: "send-failed" };
    }
};
