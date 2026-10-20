// src/services/applicationDraft.service.js
//
// Phase 5 / FR-04.07 — SAVE-AND-RETURN. The spec's flow is Personal
// Information → Resume/Documents → Additional Questions → Review & Submit, and
// it requires "save-and-return-later after email verification". This service
// owns the draft lifecycle:
//
//   save   — upsert ONE draft per candidate+requisition (payload verbatim),
//            re-issue the resume link (the old link dies), email it. The
//            candidate is reconciled by email exactly like intake (same
//            non-resurrection rule), so a returning applicant gets their own
//            draft back and a new applicant gets a row that their later
//            submission will reuse.
//   load   — resolve the emailed link token → the candidate's own draft.
//   submit — the draft becomes a real application by calling the SAME intake
//            service a fresh submission uses (mandatory fields, §2.9
//            eligibility, §3.5 question re-validation against the CURRENT
//            question set, consent) — a stale draft can never bypass a gate.
//   purge  — expiry sweep (30-day clock) + the erasure hook: an anonymized
//            candidate's drafts are deleted, never left behind.
//
// ANTI-ENUMERATION (§3.4): every failure of load/submit renders the same
// uniform response on the wire (the route owns the body); the token follows
// the §3.2 pattern (sha256 at rest, raw token only in the email).
//
// Recruitment Phase 2 — D-11: an address on the do-not-contact register gets
// no candidate row, no draft and no email, and the caller still answers with
// the uniform saved body. The draft's resume and source attribution travel
// through submit into the intake (the resume used to be dropped there).
import crypto from "node:crypto";
import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { sendCandidateEmail } from "../lib/notificationClient.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { submitPublicApplication } from "./publicPortal.service.js";
import { checkIntakeDnc, logIntakeSuppressed, normalizeSourceChannel, normalizeSourceDetail } from "../lib/intake-dnc.util.js";

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

export const DRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days from last save
export const PORTAL_DRAFT_PATH = "/public/candidates/draft";

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

/**
 * Validate the draft payload's SHAPE (content is re-validated at submit):
 * personal fields optional-but-typed, answers an object keyed by question id.
 * A draft is a WIP form, so almost everything is optional — but whatever is
 * present must be well-formed enough to store and re-render.
 */
export function parseDraftPayload(body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw fail("Invalid draft", 400, "HR-PORTAL-DRAFT-INVALID");
    }
    const text = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
    const answers = body.answers;
    if (answers !== undefined && (typeof answers !== "object" || Array.isArray(answers))) {
        throw fail("Invalid draft", 400, "HR-PORTAL-DRAFT-INVALID");
    }
    return {
        firstName: text(body.firstName),
        lastName: text(body.lastName),
        phone: text(body.phone),
        policyVersion: text(body.policyVersion),
        answers: answers && typeof answers === "object" ? answers : null,
        resumeMediaId:
            body.resumeMediaId !== undefined && body.resumeMediaId !== null && body.resumeMediaId !== ""
                ? Number(body.resumeMediaId) || null
                : null,
        source: String(body.source ?? "PORTAL").trim().toUpperCase() || "PORTAL",
        // Phase 2 — the apply link's attribution, re-validated at submit
        // against the requisition's active postings.
        sourceChannel: normalizeSourceChannel(body.sourceChannel, null),
        sourcePostingId: Number.isInteger(Number(body.sourcePostingId)) && Number(body.sourcePostingId) > 0
            ? Number(body.sourcePostingId)
            : null,
        sourceDetail: normalizeSourceDetail(body.sourceDetail),
    };
}

/**
 * Save (upsert) the candidate's draft and email the resume link.
 *
 * TX-scoped for the draft upsert; the email send happens after commit
 * (fail-soft, like every candidate email).
 *
 * @returns {Promise<{ saved: true, emailed: boolean, draftId: number|null }>}
 *   The route answers every outcome with `{ saved: true }` only; `emailed` and
 *   `draftId` are for the caller's logs and tests, never the wire.
 */
export const saveApplicationDraft = async ({ tenantId, requisitionId, email, firstName, body = {} } = {}) => {
    const address = String(email ?? "").trim().toLowerCase();
    const reqId = Number(requisitionId);
    if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || !Number.isInteger(reqId) || reqId <= 0) {
        throw fail("A valid email and requisition are required", 400, "HR-PORTAL-DRAFT-INVALID");
    }
    if (!isRecruitmentFlagEnabled("portal")) {
        // Same 404 shape as an unknown job (§3.4 no-oracle for the flag).
        throw fail("Position not found", 404, "HR-PORTAL-NOT-FOUND");
    }
    const payload = parseDraftPayload(body);

    const token = newToken();
    const saved = await tenantTransaction(
        prisma,
        async (tx) => {
            // D-11 — a register hit writes nothing at all (not even the
            // candidate row) and sends nothing.
            const dnc = await checkIntakeDnc({ tenantId, email: address, tx });
            if (dnc.blocked) return { suppressed: true, reason: dnc.reason };

            // Reconcile the candidate by email — same non-resurrection rule as intake.
            const candidate = await tx.candidate.findFirst({
                where: { tenantId, email: address, anonymizedAt: null, status: "active" },
                select: { id: true, firstName: true },
            });
            const candidateRow =
                candidate ??
                (await tx.candidate.create({
                    data: {
                        firstName: payload.firstName ?? firstName ?? "",
                        email: address,
                        status: "active",
                        tenantId,
                        source: payload.source,
                    },
                    select: { id: true, firstName: true },
                }));

            // Replace the previous token by overwriting the row (unique on
            // candidate+requisition): the old link dies with the upsert.
            const draft = await tx.applicationDraft.upsert({
                where: { candidateId_requisitionId: { candidateId: candidateRow.id, requisitionId: reqId } },
                create: scopedData(tenantId, {
                    candidateId: candidateRow.id,
                    requisitionId: reqId,
                    payload,
                    resumeMediaId: payload.resumeMediaId,
                    tokenHash: hashToken(token),
                    expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
                }),
                update: {
                    payload,
                    resumeMediaId: payload.resumeMediaId,
                    tokenHash: hashToken(token),
                    expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
                },
            });
            return { candidateRow, draft };
        },
        { tenantId },
    );
    if (saved.suppressed) {
        logIntakeSuppressed({ tenantId, email: address, path: "portal.draft_save", reason: saved.reason });
        return { saved: true, emailed: false, draftId: null };
    }
    const { candidateRow, draft } = saved;

    // Fail-soft delivery after commit.
    const base = process.env.HR_PORTAL_BASE_URL || "";
    const link = `${base}${PORTAL_DRAFT_PATH}?token=${token}&requisitionId=${reqId}`;
    const send = await sendCandidateEmail({
        tenantId,
        email: address,
        templateId: "hr.recruitment.portal_draft_link",
        data: {
            firstName: candidateRow.firstName ?? payload.firstName ?? "",
            draftUrl: link,
            expiresInDays: 30,
        },
    });

    return { saved: true, emailed: send.sent, draftId: draft.id };
};

/**
 * Load the draft behind an emailed link token. Returns null for anything the
 * route must render as the uniform "nothing here" body: unknown/expired/
 * submitted token, or a draft whose candidate was anonymized (cascade).
 */
export const loadApplicationDraft = async ({ token } = {}) => {
    const trimmed = String(token ?? "").trim();
    if (!trimmed) return null;
    const draft = await prisma.applicationDraft.findUnique({
        where: { tokenHash: hashToken(trimmed) },
        include: {
            candidate: { select: { id: true, firstName: true, anonymizedAt: true, status: true } },
            requisition: { select: { id: true, title: true } },
        },
    });
    if (!draft || draft.submittedAt) return null;
    if (draft.candidate.anonymizedAt || draft.candidate.status !== "active") return null;
    if (draft.expiresAt.getTime() <= Date.now()) return null;
    // Never hand back the requisition's internal fields or the hash.
    return {
        candidateId: draft.candidate.id,
        firstName: draft.candidate.firstName,
        requisitionId: draft.requisition.id,
        jobTitle: draft.requisition.title,
        payload: draft.payload,
        resumeMediaId: draft.resumeMediaId,
        expiresAt: draft.expiresAt.toISOString(),
    };
};

/**
 * Submit the draft as a real application THROUGH the public intake service —
 * the same mandatory-field, §2.9 eligibility and §3.5 question gates a fresh
 * submission hits (the question set may have changed since the draft was
 * saved; the draft's answers are re-validated against the CURRENT set).
 * Marks the draft submitted (kept for the reference, never re-usable).
 *
 * The tenant comes from the DRAFT ROW (the link was issued for exactly one
 * tenant) — never from the caller, who is anonymous.
 */
export const submitApplicationDraft = async ({ token } = {}) => {
    const trimmed = String(token ?? "").trim();
    if (!trimmed) {
        throw fail("This draft link is not valid", 400, "HR-PORTAL-DRAFT-INVALID");
    }
    const raw = await prisma.applicationDraft.findUnique({
        where: { tokenHash: hashToken(trimmed) },
        include: {
            candidate: { select: { id: true, email: true, firstName: true, anonymizedAt: true, status: true } },
            requisition: { select: { id: true, tenantId: true } },
        },
    });
    if (!raw || raw.submittedAt || raw.candidate.anonymizedAt || raw.candidate.status !== "active") {
        throw fail("This draft link is not valid", 400, "HR-PORTAL-DRAFT-INVALID");
    }
    // JobRequisition.tenantId is nullable (legacy rows); a draft attached to a
    // tenantless requisition has no tenant to submit under — fail closed.
    if (!raw.requisition?.tenantId) {
        throw fail("This draft link is not valid", 400, "HR-PORTAL-DRAFT-INVALID");
    }

    const p = raw.payload ?? {};
    const result = await submitPublicApplication({
        tenantId: raw.requisition.tenantId,
        requisitionId: raw.requisitionId,
        body: {
            firstName: p.firstName ?? raw.candidate.firstName ?? "",
            lastName: p.lastName ?? undefined,
            email: raw.candidate.email, // the reconciled row's own address
            phone: p.phone ?? undefined,
            answers: p.answers ?? undefined,
            policyVersion: p.policyVersion ?? undefined,
            source: p.source ?? "PORTAL",
            sourceChannel: p.sourceChannel ?? undefined,
            sourcePostingId: p.sourcePostingId ?? undefined,
            sourceDetail: p.sourceDetail ?? undefined,
        },
        // The resume would ride as a trusted argument, never a body field. The
        // draft's resumeMediaId is NOT trusted yet: draft save takes it from the
        // anonymous body, so any DAM asset id could be attached to a candidate
        // and parsed. It is carried once the portal has an upload that binds the
        // asset to this draft.
        resumeMediaId: null,
    });
    await prisma.applicationDraft.update({
        where: { id: raw.id },
        data: { submittedAt: new Date() },
    });
    return result;
};

/**
 * Erasure hook — delete the drafts of an anonymized candidate. Called by the
 * privacy service so an erasure never leaves a re-identifiable form behind.
 */
export const purgeDraftsForCandidate = async (tx, { tenantId, candidateId }) => {
    await tx.applicationDraft.deleteMany({
        where: scopedWhere(tenantId, { candidateId: Number(candidateId) }),
    });
};

/**
 * Expiry sweep — delete drafts whose 30-day clock ran out. Designed for the
 * existing scheduled-job ladder (candidate-retention pattern); returns the
 * count so the job logs it.
 */
export const purgeExpiredDrafts = async ({ now = new Date() } = {}) => {
    const result = await prisma.applicationDraft.deleteMany({
        where: { expiresAt: { lte: now }, submittedAt: null },
    });
    return { purged: result.count };
};
