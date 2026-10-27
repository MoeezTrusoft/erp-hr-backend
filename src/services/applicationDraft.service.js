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
//
// Recruitment Phase 7 (A6) — the draft's resume is VERIFIED. A typed
// resumeMediaId is refused (400 HR-RECRUITMENT-PORTAL-RESUME-UNVERIFIED); the
// form sends the `resumeRef` POST /public/candidates/resume issued for this
// tenant (and, when it was uploaded behind a draft link, for this very
// draft). The save keeps the verified media id on the row with resumeSource
// PORTAL_UPLOAD in the payload, the load hands back a fresh reference (never
// the media id), and the submit carries only a verified resume into the
// intake. A save is the whole form: a save without resumeRef has no resume.
import crypto from "node:crypto";
import prisma from "../config/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { sendCandidateEmail } from "../lib/notificationClient.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { submitPublicApplication } from "./publicPortal.service.js";
import { checkIntakeDnc, logIntakeSuppressed, normalizeSourceChannel, normalizeSourceDetail } from "./intake-dnc.service.js";
import logger from "../lib/logger.js";
import {
    PORTAL_RESUME_CODES,
    PORTAL_RESUME_SOURCE,
    hashDraftToken,
    issuePortalResumeRef,
    readPortalResumeRef,
    unverifiedResume,
} from "./portal-resume-upload.service.js";

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

export const DRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days from last save
// The careers portal page that resumes a draft (the token alone identifies it).
export const PORTAL_DRAFT_PATH = "/drafts/resume";

const hashToken = hashDraftToken;
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
 * Phase 7 — the resume half of a draft body (pure apart from the reference
 * check): a typed media id is refused, a resumeRef must be this tenant's and
 * live. null when the form has no resume.
 * @returns {{ mediaId: number, fileName: string, draftId: number|null }|null}
 */
export function parseDraftResume(body = {}, { tenantId, now = new Date() } = {}) {
    if (body?.resumeMediaId !== undefined && body.resumeMediaId !== null && body.resumeMediaId !== "") throw unverifiedResume();
    if (body?.resumeRef === undefined || body.resumeRef === null || body.resumeRef === "") return null;
    return readPortalResumeRef(body.resumeRef, { tenantId, now });
}

/**
 * A reference uploaded behind a draft link belongs to that draft only: the
 * draft must be this tenant's, still open, and the one this save addresses
 * (same address, same requisition). Checked before the do-not-contact probe,
 * from the reference and the form alone, so the answer says nothing about
 * the address.
 */
async function assertResumeBinding(tx, { tenantId, resume, address, reqId }) {
    if (!resume?.draftId) return;
    const bound = await tx.applicationDraft.findFirst({
        where: scopedWhere(tenantId, { id: resume.draftId }),
        select: { id: true, requisitionId: true, submittedAt: true, candidate: { select: { email: true } } },
    });
    const same = bound && !bound.submittedAt && bound.requisitionId === reqId
        && String(bound.candidate?.email ?? "").trim().toLowerCase() === address;
    if (!same) {
        throw fail("This resume was uploaded for another draft; upload it again", 400, PORTAL_RESUME_CODES.DRAFT_MISMATCH, {
            code: PORTAL_RESUME_CODES.DRAFT_MISMATCH,
        });
    }
}

/** The draft row's resume, only when this flow verified it (PORTAL_UPLOAD). */
export function verifiedDraftResumeId(draft) {
    const id = Number(draft?.resumeMediaId);
    return draft?.payload?.resumeSource === PORTAL_RESUME_SOURCE && Number.isInteger(id) && id > 0 ? id : null;
}

// What the load hands back: the form as saved, without a media id (a Phase 5
// payload may still carry one) and without the marker.
function publicPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload ?? null;
    const { resumeMediaId: _id, resumeSource: _source, ...rest } = payload;
    return rest;
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
    const resume = parseDraftResume(body, { tenantId });
    if (resume) {
        payload.resumeSource = PORTAL_RESUME_SOURCE;
        payload.resumeFileName = resume.fileName || null;
    }
    const resumeMediaId = resume?.mediaId ?? null;

    const token = newToken();
    const saved = await tenantTransaction(
        prisma,
        async (tx) => {
            await assertResumeBinding(tx, { tenantId, resume, address, reqId });
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
                    resumeMediaId,
                    tokenHash: hashToken(token),
                    expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
                }),
                update: {
                    payload,
                    resumeMediaId,
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
    const link = `${base}${PORTAL_DRAFT_PATH}?token=${token}`;
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

// Phase 7 fix — ApplicationDraft has no `requisition` relation (only the
// requisitionId column), so the old `include: { requisition }` failed Prisma
// validation and every draft load and submit fell into the uniform dead-link
// body. The requisition is read on its own, in the draft's tenant.
async function draftRequisition(draft, select) {
    return await prisma.jobRequisition.findFirst({
        where: { id: draft.requisitionId, ...(draft.tenantId ? { tenantId: draft.tenantId } : {}) },
        select,
    });
}

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
        },
    });
    if (!draft || draft.submittedAt) return null;
    if (draft.candidate.anonymizedAt || draft.candidate.status !== "active") return null;
    if (draft.expiresAt.getTime() <= Date.now()) return null;
    const requisition = await draftRequisition(draft, { id: true, title: true });
    if (!requisition) return null;
    // Never hand back the requisition's internal fields, the hash or a media id.
    return {
        candidateId: draft.candidate.id,
        firstName: draft.candidate.firstName,
        requisitionId: requisition.id,
        jobTitle: requisition.title,
        payload: publicPayload(draft.payload),
        resume: draftResumeView(draft),
        expiresAt: draft.expiresAt.toISOString(),
    };
};

// Phase 7 — the saved resume as the form needs it to save again: a fresh
// reference bound to this draft, and the file name. A reference that cannot be
// minted (no key) leaves resumeRef null rather than failing the load.
function draftResumeView(draft) {
    const mediaId = verifiedDraftResumeId(draft);
    if (!mediaId) return null;
    const fileName = draft.payload?.resumeFileName ?? null;
    try {
        const { resumeRef, expiresAt } = issuePortalResumeRef({ tenantId: draft.tenantId, mediaId, fileName, draftId: draft.id });
        return { resumeRef, fileName, refExpiresAt: expiresAt.toISOString() };
    } catch (err) {
        logger.warn({ draftId: draft.id, code: err?.code ?? null }, "draft load: resume reference unavailable");
        return { resumeRef: null, fileName, refExpiresAt: null };
    }
}

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
    const found = await prisma.applicationDraft.findUnique({
        where: { tokenHash: hashToken(trimmed) },
        include: {
            candidate: { select: { id: true, email: true, firstName: true, anonymizedAt: true, status: true } },
        },
    });
    if (!found || found.submittedAt || found.candidate.anonymizedAt || found.candidate.status !== "active") {
        throw fail("This draft link is not valid", 400, "HR-PORTAL-DRAFT-INVALID");
    }
    const raw = { ...found, requisition: await draftRequisition(found, { id: true, tenantId: true }) };
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
        // The resume rides as a trusted argument, never a body field, and only
        // when the draft save verified it (Phase 7: a PORTAL_UPLOAD reference).
        // A Phase 5 draft's typed id is dropped.
        resumeMediaId: verifiedDraftResumeId(raw),
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
