import logger from "../lib/logger.js";
// src/services/candidateVerification.service.js
//
// Phase 5 / decision record §3.2 (email magic links) + §3.4 second half (the
// mailbox-owner notice) — the candidate-facing EMAIL story.
//
// HR commits token hashes and encrypted pending mailbox messages atomically.
// The delivery worker sends after commit and removes its encrypted payload
// after durable Notification Hub acceptance. Raw links never enter domain events.
//
// ANTI-ENUMERATION (§3.4 applied to this surface):
//   * consumeToken's failure shape is IDENTICAL for unknown/expired/used/wrong
//     candidate — one generic message, one 400 code, no hint at which failed.
//   * Mailbox-owner notices use the same durable queue and uniform intake response.
import crypto from "node:crypto";
import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { queueMailboxMessage } from "./candidateMailboxQueue.service.js";

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24h — long enough for a busy applicant
const STATUS_LINK_TTL_MS = 1000 * 60 * 60 * 24 * 180; // §3.5a link: 180d, re-requestable

const fail = (message, status, code, details) =>
  Object.assign(new Error(message), {
    status,
    code,
    ...(details ? { details } : {}),
  });

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const newToken = () => crypto.randomBytes(32).toString("base64url");

export const EMAIL_VERIFICATION_PURPOSES = Object.freeze([
  "APPLY_VERIFICATION",
  "STATUS_LINK",
]);

export const PORTAL_VERIFY_PATH = "/verify";
export const PORTAL_STATUS_PATH = "/status";

/**
 * §3.2 — mint a verification token for the candidate's email. TX-SCOPED and
 * HTTP-FREE: the token hash and encrypted delivery intent join the caller's
 * transaction atomically. The delivery worker sends only committed messages.
 *
 * Re-issue semantics: one row per candidate+purpose — an existing UNCONSUMED
 * token is replaced (the previous link dies), a CONSUMED row is left as the
 * audit and a fresh row is created. A candidate who re-applies gets a fresh,
 * working link every time.
 *
 * @returns {Promise<null | {candidateId: number, email: string, firstName: string, token: string}>}
 *          null when there is nothing to verify against (no candidate/email).
 */
export const issueEmailVerification = async (
  tx,
  { tenantId, candidate, email, now = new Date() },
) => {
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

  await queueMailboxMessage(tx, {
    tenantId,
    candidate,
    email: address,
    token,
    tokenPurpose: "APPLY_VERIFICATION",
    templateKey: "portal_email_verification",
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
  });
  return {
    candidateId: candidate.id,
    email: address,
    firstName: candidate.firstName ?? "",
    token,
  };
};

/**
 * §3.5a — mint a STATUS LINK for the candidate: a long-lived, re-usable,
 * NON-consuming token whose presentation returns the candidate's own visible
 * application statuses. The link is emailed to the candidate's address (the
 * same hub-owned delivery as §3.2), so possession of the mailbox is the only
 * way to obtain or refresh it. Re-issue replaces the previous live link.
 *
 * TX-scoped like issueEmailVerification: the worker sends its queued status
 * link after commit.
 *
 * @returns {Promise<null | {candidateId: number, email: string, firstName: string, token: string}>}
 */
export const issueStatusLink = async (
  tx,
  {
    tenantId,
    candidate,
    email,
    now = new Date(),
    templateKey = "portal_status_link",
    applicationRef = null,
    jobTitle = "",
  },
) => {
  const address = email ?? candidate?.email;
  if (!address || !candidate?.id) return null;

  await tx.candidateEmailVerification.updateMany({
    where: scopedWhere(tenantId, {
      candidateId: candidate.id,
      purpose: "STATUS_LINK",
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
      purpose: "STATUS_LINK",
      // Long-lived but not forever: re-requesting is cheap and safe.
      expiresAt: new Date(now.getTime() + STATUS_LINK_TTL_MS),
    }),
  });
  await queueMailboxMessage(tx, {
    tenantId,
    candidate,
    email: address,
    token,
    tokenPurpose: "STATUS_LINK",
    templateKey,
    applicationRef,
    jobTitle,
    expiresAt: new Date(now.getTime() + STATUS_LINK_TTL_MS),
  });
  return {
    candidateId: candidate.id,
    email: address,
    firstName: candidate.firstName ?? "",
    token,
  };
};

/**
 * §3.5a — resolve a presented STATUS-LINK token to the candidate's visible
 * applications. NOT consuming: the link keeps working until it expires or is
 * replaced, so the candidate can re-check.
 *
 * Returns the candidate only for a LIVE (unconsumed, unexpired) token — the
 * caller renders the uniform empty body otherwise, so a wrong/revoked/expired
 * link and a link-holder with no applications are indistinguishable (§3.4).
 *
 * @returns {Promise<null | {candidateId: number, email: string}>}
 */
export const resolveStatusLink = async ({
  tenantId,
  token,
  now = new Date(),
  db = prisma,
} = {}) => {
  const trimmed = String(token ?? "").trim();
  if (!tenantId || !/^[A-Za-z0-9_-]{43}$/.test(trimmed)) return null;
  const row = await db.candidateEmailVerification.findUnique({
    where: { tokenHash: hashToken(trimmed), tenantId },
  });
  if (
    !row ||
    row.purpose !== "STATUS_LINK" ||
    row.consumedAt ||
    row.expiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }
  const candidate = await db.candidate.findFirst({
    where: {
      id: row.candidateId,
      tenantId,
      anonymizedAt: null,
      status: "active",
      email: row.email,
    },
  });
  return candidate
    ? { candidateId: row.candidateId, tenantId, email: row.email }
    : null;
};

/**
 * §3.2 — consume a presented token: prove the mailbox owner saw the mail and
 * stamp `candidates.emailVerifiedAt`.
 *
 * UNIFORM FAILURE (§3.4, no-oracle): unknown token, expired, already consumed
 * and candidate-mismatch are the SAME 400 with the SAME body — the endpoint
 * cannot be probed for which emails exist or which links are live.
 */
export const consumeEmailVerification = async ({
  tenantId,
  token,
  now = new Date(),
} = {}) => {
  const trimmed = String(token ?? "").trim();
  if (!tenantId || !/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    throw fail(
      "This verification link is not valid",
      400,
      "HR-PORTAL-VERIFY-INVALID",
    );
  }
  const row = await prisma.candidateEmailVerification.findUnique({
    where: { tokenHash: hashToken(trimmed), tenantId },
  });
  const usable =
    row &&
    row.purpose === "APPLY_VERIFICATION" &&
    !row.consumedAt &&
    row.expiresAt.getTime() > now.getTime();
  if (!usable) {
    // One shape for every failure; log the class server-side only.
    logger.warn(
      {
        tokenClass: row ? (row.consumedAt ? "consumed" : "expired") : "unknown",
      },
      "portal email verify refused",
    );
    throw fail(
      "This verification link is not valid",
      400,
      "HR-PORTAL-VERIFY-INVALID",
    );
  }

  // The stamp + the consume commit together: a replayed token can never stamp
  // twice, and a crashed write cannot leave a verified state with a live link.
  const updated = await tenantTransaction(
    prisma,
    async (tx) => {
      const target = await tx.candidateEmailVerification.findUnique({
        where: { tokenHash: row.tokenHash },
      });
      if (
        !target ||
        target.purpose !== "APPLY_VERIFICATION" ||
        target.tenantId !== tenantId ||
        target.consumedAt ||
        target.expiresAt.getTime() <= now.getTime()
      ) {
        throw fail(
          "This verification link is not valid",
          400,
          "HR-PORTAL-VERIFY-INVALID",
        );
      }
      const active = await tx.candidate.findFirst({
        where: {
          id: target.candidateId,
          tenantId,
          anonymizedAt: null,
          status: "active",
          email: target.email,
        },
      });
      if (!active)
        throw fail(
          "This verification link is not valid",
          400,
          "HR-PORTAL-VERIFY-INVALID",
        );
      const consumed = await tx.candidateEmailVerification.updateMany({
        where: { id: target.id, tenantId, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1)
        throw fail(
          "This verification link is not valid",
          400,
          "HR-PORTAL-VERIFY-INVALID",
        );
      // The verification proves the EMAIL, so the stamp follows the address,
      // not the row that happened to carry it — but candidates are keyed by
      // (tenant, email) uniquely, so stamping the owning candidate is exact.
      return tx.candidate.update({
        where: { id: target.candidateId },
        data: { emailVerifiedAt: now, version: { increment: 1 } },
      });
    },
    { tenantId },
  );

  return {
    verified: true,
    candidateId: updated.id,
    email: row.email,
  };
};
