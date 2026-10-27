// src/services/dsr-portal.service.js
//
// Recruitment Phase 5 (plan 6.9) — data-subject requests from the careers
// portal, their verification, the 30-day SLA alert and the unverified sweep.
// Behind the `dsrPortal` flag (HR_RECRUITMENT_DSR_PORTAL).
//
//   submitPortalDsr          POST /public/privacy/requests { email, type, details? }.
//       Always the same { accepted: true }, whether or not the address belongs
//       to a candidate (no oracle). Records a CandidateDataAccessRequest with
//       source PORTAL and the sha256 of a random token that expires in 48
//       hours, announces hr.recruitment.dsr_verification_requested.v1 (ids
//       only) in the same transaction, then emails the link through the
//       Notification Hub (fail-soft, template hr.recruitment.dsr_verification).
//       The raw token never touches the outbox or the database. At most
//       MAX_PENDING_PER_EMAIL live unverified requests per address, so the form
//       cannot be used to flood someone's mailbox; beyond that the answer is
//       the same and nothing is sent.
//   verifyPortalDsr          GET|POST /public/privacy/requests/verify?token=.
//       A live token stamps verifiedAt, starts the SLA clock (dueAt = verifiedAt
//       + 30 days), links the candidate whose email matches (when one exists)
//       and announces hr.recruitment.dsr_verified.v1 for HR. The token is
//       single-use. The route answers the same neutral page for every outcome.
//   runDsrVerificationSweepJob  deletes unverified portal requests whose link
//       expired: they never reached the HR queue and hold an unproven address.
//   runDsrSlaJob             daily: every open verified request due within 5
//       days (or overdue) alerts HR once (slaAlertedAt;
//       hr.recruitment.dsr_sla_at_risk.v1).
//
// Unverified portal requests never reach the HR queue: candidatePrivacy's
// list and close read only HR-source or verified rows.
import { createHash, randomBytes } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../lib/requestContext.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { sendCandidateEmail } from "../lib/notificationClient.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const log = logger.child({ component: "dsr-portal" });

export const DSR_VERIFICATION_REQUESTED_EVENT = "hr.recruitment.dsr_verification_requested.v1";
export const DSR_VERIFIED_EVENT = "hr.recruitment.dsr_verified.v1";
export const DSR_SLA_AT_RISK_EVENT = "hr.recruitment.dsr_sla_at_risk.v1";
export const DSR_VERIFICATION_TEMPLATE_ID = "hr.recruitment.dsr_verification";
// The careers portal page that posts the token to the verify endpoint.
export const PORTAL_DSR_VERIFY_PATH = "/privacy/verify";

export const DSR_TYPES = Object.freeze(["ACCESS", "CORRECTION", "ERASURE"]);
export const DSR_OPEN_STATUSES = Object.freeze(["RECEIVED", "IN_PROGRESS"]);
export const DSR_VERIFICATION_HOURS = 48;
export const DSR_SLA_DAYS = 30;
export const DSR_AT_RISK_DAYS = 5;
export const MAX_PENDING_PER_EMAIL = 3;
const DETAILS_MAX = 2000;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_JOB_LIMIT = 500;
const MAX_JOB_LIMIT = 5000;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

export const hashDsrToken = (token) => createHash("sha256").update(String(token)).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const trimSlash = (value) => String(value ?? "").trim().replace(/\/+$/, "");
const idStr = (value) => (value != null ? String(value) : null);
const clampLimit = (limit) => {
    const n = Math.floor(Number(limit));
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_JOB_LIMIT) : DEFAULT_JOB_LIMIT;
};

const requirePortalEnabled = () => {
    if (!isRecruitmentFlagEnabled("dsrPortal")) {
        throw fail("Privacy requests are not available", 503, "HR-RECRUITMENT-DSR-PORTAL-DISABLED");
    }
};

const SYSTEM = (fn) => mcpCtx.run({ ...(mcpCtx.getStore() ?? {}), system: true }, fn);
const AS_TENANT = (tenantId, fn) =>
    mcpCtx.run({ correlationId: mcpCtx.getStore()?.correlationId, user: { tenantId } }, fn);

// ── Events (ids only: never the address, the details text or the token) ─────

function dsrEvent(eventName, request, extra = {}) {
    if (!request?.tenantId) return null;
    return {
        eventName,
        tenantId: request.tenantId,
        aggregateType: "CandidateDataAccessRequest",
        aggregateId: request.id,
        actorId: null,
        payload: { requestId: String(request.id), type: request.type, ...extra },
    };
}

/** hr.recruitment.dsr_verification_requested.v1 — a portal request awaits its link. */
export const dsrVerificationRequestedEvent = (request) =>
    dsrEvent(DSR_VERIFICATION_REQUESTED_EVENT, request, {
        source: "PORTAL",
        expiresAt: request.verificationExpiresAt ? new Date(request.verificationExpiresAt).toISOString() : null,
    });

/** hr.recruitment.dsr_verified.v1 — the request entered the HR queue. */
export const dsrVerifiedEvent = (request, { dataPolicyOwnerId = null } = {}) =>
    dsrEvent(DSR_VERIFIED_EVENT, request, {
        source: "PORTAL",
        candidateId: idStr(request.candidateId),
        dueAt: request.dueAt ? new Date(request.dueAt).toISOString() : null,
        dataPolicyOwnerId: idStr(dataPolicyOwnerId),
    });

/** hr.recruitment.dsr_sla_at_risk.v1 — due within the window, or overdue. */
export function dsrSlaAtRiskEvent(request, { now = new Date(), dataPolicyOwnerId = null } = {}) {
    const due = new Date(request.dueAt);
    const daysRemaining = Math.ceil((due.getTime() - new Date(now).getTime()) / DAY_MS);
    return dsrEvent(DSR_SLA_AT_RISK_EVENT, request, {
        source: request.source ?? "HR",
        candidateId: idStr(request.candidateId),
        dueAt: due.toISOString(),
        daysRemaining,
        overdue: due.getTime() < new Date(now).getTime(),
        // Recipients: the handler when one is assigned, else the owner, else
        // the tenant's HR admins (hub fallback).
        handledById: idStr(request.handledById),
        dataPolicyOwnerId: idStr(dataPolicyOwnerId),
    });
}

// ── Intake ───────────────────────────────────────────────────────────────────

/** Validate the portal body. Pure; throws 400 on a malformed request. */
export function parseDsrSubmission(body = {}) {
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
        throw fail("A valid email address is required", 400, "HR-RECRUITMENT-DSR-EMAIL-INVALID");
    }
    const type = String(body?.type ?? "").trim().toUpperCase();
    if (!DSR_TYPES.includes(type)) {
        throw fail(`type must be one of ${DSR_TYPES.join(", ")}`, 400, "HR-RECRUITMENT-DSR-TYPE-INVALID");
    }
    const rawDetails = body?.details;
    if (rawDetails != null && typeof rawDetails !== "string") {
        throw fail("details must be text", 400, "HR-RECRUITMENT-DSR-DETAILS-INVALID");
    }
    const details = typeof rawDetails === "string" ? rawDetails.trim() : "";
    if (details.length > DETAILS_MAX) {
        throw fail(`details must be at most ${DETAILS_MAX} characters`, 400, "HR-RECRUITMENT-DSR-DETAILS-INVALID");
    }
    return { email, type, details: details || null };
}

async function portalFacts(db, tenantId) {
    const row = await db.tenantRecruitmentSettings.findUnique({
        where: { tenantId },
        select: { portalBaseUrl: true, companyName: true, dataPolicyOwnerId: true },
    });
    return { portalBaseUrl: row?.portalBaseUrl ?? null, companyName: row?.companyName ?? null, dataPolicyOwnerId: row?.dataPolicyOwnerId ?? null };
}

/**
 * Record a portal data-subject request and email its verification link.
 * Uniform: every accepted path returns { accepted: true }.
 */
export async function submitPortalDsr({ tenantId, body, now = new Date() } = {}) {
    requirePortalEnabled();
    if (!tenantId) throw fail("Not found", 404, "HR-RECRUITMENT-DSR-NOT-FOUND");
    const { email, type, details } = parseDsrSubmission(body);
    const at = new Date(now);
    const token = newToken();
    const expiresAt = new Date(at.getTime() + DSR_VERIFICATION_HOURS * HOUR_MS);

    const created = await tenantTransaction(
        prisma,
        async (tx) => {
            // One address at a time, so the pending cap holds under concurrency.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:dsr-intake:${email}`}))`;
            const pending = await tx.candidateDataAccessRequest.count({
                where: withTenant(tenantId, {
                    source: "PORTAL",
                    subjectEmail: email,
                    verifiedAt: null,
                    verificationExpiresAt: { gt: at },
                }),
            });
            if (pending >= MAX_PENDING_PER_EMAIL) return null;
            const row = await tx.candidateDataAccessRequest.create({
                data: {
                    tenantId,
                    subjectEmail: email,
                    type,
                    status: "RECEIVED",
                    receivedAt: at,
                    // The SLA clock starts at verification, not at submission.
                    dueAt: null,
                    notes: details,
                    source: "PORTAL",
                    verificationTokenHash: hashDsrToken(token),
                    verificationExpiresAt: expiresAt,
                },
                select: { id: true, tenantId: true, type: true, verificationExpiresAt: true },
            });
            await enqueueHrDomainEvent(tx, dsrVerificationRequestedEvent({ ...row, tenantId: row.tenantId ?? tenantId }));
            return row;
        },
        { tenantId },
    );

    if (!created) {
        log.info({ tenantId }, "dsr intake: pending cap reached for an address, nothing sent");
        return { accepted: true };
    }

    // Fail-soft delivery after commit: the request stands (and expires) even if
    // the hub is down; the requester can submit again.
    const facts = await portalFacts(prisma, tenantId);
    const base = trimSlash(facts.portalBaseUrl || process.env.HR_PORTAL_BASE_URL);
    if (!base) {
        log.warn({ tenantId, requestId: created.id }, "dsr intake: no portal address configured, verification link not sent");
        return { accepted: true };
    }
    const send = await sendCandidateEmail({
        tenantId,
        email,
        templateId: DSR_VERIFICATION_TEMPLATE_ID,
        data: {
            verifyUrl: `${base}${PORTAL_DSR_VERIFY_PATH}?token=${token}`,
            requestType: type,
            companyName: facts.companyName ?? "",
            expiresAt: expiresAt.toISOString(),
            validityHours: DSR_VERIFICATION_HOURS,
        },
        dedupeKey: `hr-dsr-verification:${created.id}`,
        category: "PRIVACY",
    });
    if (!send?.sent) log.warn({ tenantId, requestId: created.id, reason: send?.reason }, "dsr verification email not sent");
    return { accepted: true };
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify a presented token. Returns { verified: true, requestId } for a live
 * token and { verified: false } for anything else; the route renders the same
 * page either way.
 */
export async function verifyPortalDsr({ tenantId, token, now = new Date() } = {}) {
    requirePortalEnabled();
    if (!tenantId || typeof token !== "string" || !TOKEN_RE.test(token)) return { verified: false };
    const at = new Date(now);
    const tokenHash = hashDsrToken(token);

    const verified = await tenantTransaction(
        prisma,
        async (tx) => {
            const request = await tx.candidateDataAccessRequest.findFirst({
                where: withTenant(tenantId, { source: "PORTAL", verificationTokenHash: tokenHash, verifiedAt: null }),
                select: { id: true, tenantId: true, type: true, subjectEmail: true, verificationExpiresAt: true },
            });
            if (!request || !request.verificationExpiresAt || new Date(request.verificationExpiresAt) <= at) return null;

            const candidate = await tx.candidate.findFirst({
                where: withTenant(tenantId, { email: { equals: request.subjectEmail, mode: "insensitive" }, anonymizedAt: null }),
                select: { id: true },
                orderBy: { id: "asc" },
            });
            const dueAt = new Date(at.getTime() + DSR_SLA_DAYS * DAY_MS);
            const claim = await tx.candidateDataAccessRequest.updateMany({
                where: withTenant(tenantId, {
                    id: request.id,
                    verifiedAt: null,
                    verificationTokenHash: tokenHash,
                    verificationExpiresAt: { gt: at },
                }),
                // Single-use: the hash is cleared with the claim.
                data: { verifiedAt: at, dueAt, verificationTokenHash: null, candidateId: candidate?.id ?? null },
            });
            if (Number(claim?.count ?? 0) !== 1) return null;
            const facts = await portalFacts(tx, tenantId);
            const row = { ...request, tenantId: request.tenantId ?? tenantId, candidateId: candidate?.id ?? null, dueAt };
            await enqueueHrDomainEvent(tx, dsrVerifiedEvent(row, facts));
            return row;
        },
        { tenantId },
    );
    if (!verified) return { verified: false };
    log.info({ tenantId, requestId: verified.id, matched: verified.candidateId != null }, "dsr verified");
    return { verified: true, requestId: verified.id };
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

const groupByTenant = (rows) => {
    const byTenant = new Map();
    for (const row of rows) {
        if (!row.tenantId) continue;
        if (!byTenant.has(row.tenantId)) byTenant.set(row.tenantId, []);
        byTenant.get(row.tenantId).push(row);
    }
    return byTenant;
};

/**
 * Delete unverified portal requests whose link expired. Not flag-gated on
 * purpose: deleting an unproven, never-queued address is the minimising
 * direction, and rows written while the flag was on must not linger after it
 * is turned off.
 */
export async function runDsrVerificationSweepJob({ now = new Date(), limit } = {}) {
    const at = new Date(now);
    const summary = { scanned: 0, deleted: 0, failed: 0 };
    const rows = await SYSTEM(async () =>
        await prisma.candidateDataAccessRequest.findMany({
            where: { source: "PORTAL", verifiedAt: null, verificationExpiresAt: { lt: at } },
            select: { id: true, tenantId: true },
            orderBy: [{ id: "asc" }],
            take: clampLimit(limit),
        }),
    );
    summary.scanned = rows.length;
    for (const [tenantId, list] of groupByTenant(rows)) {
        try {
            const res = await AS_TENANT(tenantId, async () =>
                await prisma.candidateDataAccessRequest.deleteMany({
                    // Re-checked at delete time: a request verified meanwhile stays.
                    where: withTenant(tenantId, {
                        id: { in: list.map((r) => r.id) },
                        source: "PORTAL",
                        verifiedAt: null,
                        verificationExpiresAt: { lt: at },
                    }),
                }),
            );
            summary.deleted += Number(res?.count ?? 0);
        } catch (err) {
            summary.failed += list.length;
            log.warn({ tenantId, errMessage: err?.message }, "dsr verification sweep: tenant failed");
        }
    }
    if (summary.scanned) log.info(summary, "dsr verification sweep: done");
    return summary;
}

/** Claim and announce one at-risk request under its tenant (once, ever). */
async function alertOne(tenantId, requestId, { now, horizon, dataPolicyOwnerId }) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const request = await tx.candidateDataAccessRequest.findFirst({
                where: withTenant(tenantId, { id: requestId }),
                select: { id: true, tenantId: true, type: true, source: true, status: true, dueAt: true, verifiedAt: true, slaAlertedAt: true, candidateId: true, handledById: true },
            });
            if (!request || request.slaAlertedAt || !DSR_OPEN_STATUSES.includes(request.status)) return "skipped";
            if (!request.dueAt || new Date(request.dueAt) > horizon) return "skipped";
            if (request.source === "PORTAL" && !request.verifiedAt) return "skipped";
            const claim = await tx.candidateDataAccessRequest.updateMany({
                where: withTenant(tenantId, { id: request.id, slaAlertedAt: null, status: { in: [...DSR_OPEN_STATUSES] } }),
                data: { slaAlertedAt: now },
            });
            if (Number(claim?.count ?? 0) !== 1) return "skipped";
            await enqueueHrDomainEvent(
                tx,
                dsrSlaAtRiskEvent({ ...request, tenantId: request.tenantId ?? tenantId }, { now, dataPolicyOwnerId }),
            );
            return new Date(request.dueAt) < now ? "overdue" : "alerted";
        },
        { tenantId },
    );
}

/**
 * The daily SLA pass: open, verified requests due within DSR_AT_RISK_DAYS (or
 * overdue) alert HR once. Idempotent (slaAlertedAt claim), one bad row never
 * stops the run.
 */
export async function runDsrSlaJob({ now = new Date(), limit } = {}) {
    if (!isRecruitmentFlagEnabled("dsrPortal")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const horizon = new Date(at.getTime() + DSR_AT_RISK_DAYS * DAY_MS);
    const summary = { scanned: 0, alerted: 0, overdue: 0, skipped: 0, failed: 0 };

    const rows = await SYSTEM(async () =>
        await prisma.candidateDataAccessRequest.findMany({
            where: {
                status: { in: [...DSR_OPEN_STATUSES] },
                slaAlertedAt: null,
                dueAt: { lte: horizon },
                OR: [{ source: "HR" }, { verifiedAt: { not: null } }],
            },
            select: { id: true, tenantId: true },
            orderBy: [{ dueAt: "asc" }, { id: "asc" }],
            take: clampLimit(limit),
        }),
    );
    summary.scanned = rows.length;

    for (const [tenantId, list] of groupByTenant(rows)) {
        await AS_TENANT(tenantId, async () => {
            let owner = null;
            try {
                owner = (await portalFacts(prisma, tenantId)).dataPolicyOwnerId;
            } catch (err) {
                log.warn({ tenantId, errMessage: err?.message }, "dsr sla: settings unavailable, owner left unset");
            }
            for (const row of list) {
                try {
                    const outcome = await alertOne(tenantId, row.id, { now: at, horizon, dataPolicyOwnerId: owner });
                    summary[outcome] += 1;
                    if (outcome === "overdue") summary.alerted += 1;
                } catch (err) {
                    summary.failed += 1;
                    log.warn({ tenantId, requestId: row.id, errMessage: err?.message }, "dsr sla: request failed");
                }
            }
        });
    }
    if (summary.scanned) log.info(summary, "dsr sla: pass done");
    return summary;
}
