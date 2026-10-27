// src/services/portal-resume-upload.service.js
//
// Recruitment Phase 7 (A6) — the careers site's resume upload.
//
// Until now a careers draft carried a `resumeMediaId` typed by the anonymous
// visitor, so a draft could point at ANY DAM asset (another candidate's
// resume, another tenant's file). The fix is the same one the agency flow got
// in Phase 6: the backend stores the file itself and hands back something only
// it can have produced.
//
//   uploadPortalResume   POST /public/candidates/resume. The file must be a
//       PDF and pass the portal upload rules (lib/onboarding-upload.util.js:
//       extension, canonical base64, 10 MB, the %PDF- signature), the same
//       rules the agency upload uses. It is stored with uploadFileToDAM
//       ("document") under the pinned tenant's context, which is how every
//       candidate resume reaches DAM. The answer is an OPAQUE reference, never
//       the media id.
//   The reference is AES-256-GCM over { tenant, media id, cleaned file name,
//       the draft it is bound to (optional), expiry }, so it is unreadable and
//       unforgeable without the server key, and it is only good in the tenant
//       that issued it. No table: Phase 7 needs no schema change, and a
//       reference is short-lived (24 h) because the draft row keeps the
//       verified media id once the draft is saved.
//   readPortalResumeRef  decodes and checks it (tenant, expiry, integrity).
//       Every refusal is a 400 with its own code; another tenant's reference
//       reads as invalid, never as "valid elsewhere".
//
// The key comes from HR_PORTAL_RESUME_REF_KEY (base64, at least 32 bytes) or,
// when that is not set, is derived with HKDF from HR_C4_ENCRYPTION_KEY under
// its own label (so it is never the C4 key itself). With neither, uploads fail
// closed with a 503 before anything is stored.
//
// The resume then travels the path it always did: the draft save keeps the
// verified id on the draft row (with resumeSource PORTAL_UPLOAD in the
// payload), and submit hands it to submitPublicApplication as the trusted
// `resumeMediaId`, which links it to the candidate and queues the parse.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { validateOnboardingUpload, normalizeMimeType } from "../lib/onboarding-upload.util.js";
import { uploadFileToDAM } from "./dam.media.service.js";

const log = logger.child({ component: "portal-resume-upload" });

// The marker a draft payload carries when its resumeMediaId came from here.
export const PORTAL_RESUME_SOURCE = "PORTAL_UPLOAD";
export const PORTAL_RESUME_MIME = "application/pdf";
export const PORTAL_RESUME_REF_TTL_MS = 24 * 60 * 60 * 1000;

export const PORTAL_RESUME_CODES = Object.freeze({
    INVALID_FILE: "HR-RECRUITMENT-PORTAL-RESUME-INVALID",
    REF_INVALID: "HR-RECRUITMENT-PORTAL-RESUME-REF-INVALID",
    REF_EXPIRED: "HR-RECRUITMENT-PORTAL-RESUME-REF-EXPIRED",
    DRAFT_MISMATCH: "HR-RECRUITMENT-PORTAL-RESUME-DRAFT-MISMATCH",
    DRAFT_INVALID: "HR-RECRUITMENT-PORTAL-RESUME-DRAFT-INVALID",
    UNVERIFIED: "HR-RECRUITMENT-PORTAL-RESUME-UNVERIFIED",
    UNAVAILABLE: "HR-RECRUITMENT-PORTAL-RESUME-UNAVAILABLE",
});

const REF_PREFIX = "pr1.";
const REF_AAD = Buffer.from("hr-portal-resume-ref.v1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const REF_MAX_LENGTH = 1024;

const fail = (message, status, code, details = {}) =>
    Object.assign(new Error(message), { status, code, details: { code, ...details } });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/** sha256 hex of a draft link token (the at-rest form of every draft token). */
export const hashDraftToken = (token) => createHash("sha256").update(String(token)).digest("hex");

// ── The reference ────────────────────────────────────────────────────────────

const unavailable = () =>
    fail("Resume upload is not available right now. Please try again later.", 503, PORTAL_RESUME_CODES.UNAVAILABLE);

function decodeKey(raw) {
    const key = Buffer.from(String(raw ?? ""), "base64");
    return key.length >= 32 ? key : null;
}

/** The reference key: the dedicated secret, or a label-bound HKDF of the C4 key. */
function referenceKey() {
    const ikm = decodeKey(process.env.HR_PORTAL_RESUME_REF_KEY) ?? decodeKey(process.env.HR_C4_ENCRYPTION_KEY);
    if (!ikm) throw unavailable();
    return Buffer.from(hkdfSync("sha256", ikm, "hr-portal-resume-ref", "hr-portal-resume-ref.v1", 32));
}

/** True when a reference can be minted (checked before a file is stored). */
export function assertPortalResumeRefsAvailable() {
    referenceKey();
}

/**
 * Mint the opaque reference for a stored resume.
 * @returns {{ resumeRef: string, expiresAt: Date }}
 */
export function issuePortalResumeRef({ tenantId, mediaId, fileName, draftId = null, now = new Date() }) {
    const media = positiveInt(mediaId);
    if (!tenantId || !media) throw unavailable();
    const expiresAt = new Date(now.getTime() + PORTAL_RESUME_REF_TTL_MS);
    const body = JSON.stringify({ t: String(tenantId), m: media, n: String(fileName ?? ""), d: positiveInt(draftId), e: expiresAt.getTime() });
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", referenceKey(), iv);
    cipher.setAAD(REF_AAD);
    const sealed = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
    return { resumeRef: `${REF_PREFIX}${packed}`, expiresAt };
}

const refInvalid = () => fail("The resume reference is not valid; upload the resume again", 400, PORTAL_RESUME_CODES.REF_INVALID);

/**
 * Decode and check a reference for the pinned tenant.
 * @returns {{ mediaId: number, fileName: string, draftId: number|null, expiresAt: Date }}
 * @throws 400 REF_INVALID (malformed, forged, another tenant's) or REF_EXPIRED
 */
export function readPortalResumeRef(resumeRef, { tenantId, now = new Date() } = {}) {
    const text = typeof resumeRef === "string" ? resumeRef.trim() : "";
    if (!text.startsWith(REF_PREFIX) || text.length > REF_MAX_LENGTH) throw refInvalid();
    const key = referenceKey();
    let claims;
    try {
        const packed = Buffer.from(text.slice(REF_PREFIX.length), "base64url");
        if (packed.length <= IV_BYTES + TAG_BYTES) throw refInvalid();
        const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, IV_BYTES));
        decipher.setAAD(REF_AAD);
        decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const plain = Buffer.concat([decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
        claims = JSON.parse(plain.toString("utf8"));
    } catch {
        throw refInvalid();
    }
    const mediaId = positiveInt(claims?.m);
    if (!mediaId || !tenantId || claims?.t !== String(tenantId) || !Number.isFinite(claims?.e)) throw refInvalid();
    if (claims.e <= now.getTime()) {
        throw fail("The resume upload has expired; upload the resume again", 400, PORTAL_RESUME_CODES.REF_EXPIRED);
    }
    return { mediaId, fileName: String(claims.n ?? ""), draftId: positiveInt(claims.d), expiresAt: new Date(claims.e) };
}

// ── The file ─────────────────────────────────────────────────────────────────

/**
 * The visitor's resume file (pure): PDF only, the portal upload rules.
 * @returns {{ buffer: Buffer, mimeType: string, fileName: string, size: number }}
 * @throws 400 HR-RECRUITMENT-PORTAL-RESUME-INVALID with details.reason
 */
export function validatePortalResume(resume) {
    if (!resume || typeof resume !== "object" || Array.isArray(resume)) {
        throw fail("Send the resume as { fileName, mimeType, contentBase64 }", 400, PORTAL_RESUME_CODES.INVALID_FILE, { reason: "SHAPE" });
    }
    if (normalizeMimeType(resume.mimeType) !== PORTAL_RESUME_MIME) {
        throw fail("The resume must be a PDF file", 400, PORTAL_RESUME_CODES.INVALID_FILE, { reason: "TYPE" });
    }
    try {
        return validateOnboardingUpload({ fileName: resume.fileName, mimeType: PORTAL_RESUME_MIME, contentBase64: resume.contentBase64 });
    } catch (err) {
        // HR-ONBOARDING-UPLOAD-SIGNATURE -> SIGNATURE, ...-TOO-LARGE -> TOO_LARGE.
        const reason = String(err?.code ?? "").replace(/^HR-ONBOARDING-UPLOAD-/, "").replace(/-/g, "_") || "CONTENT";
        throw fail(err?.message || "The resume file is not valid", 400, PORTAL_RESUME_CODES.INVALID_FILE, { reason });
    }
}

/** A live, unsubmitted draft of this tenant behind a draft link token, or a 400. */
async function draftForUpload({ tenantId, draftToken, now }) {
    const token = String(draftToken ?? "").trim();
    const draftInvalid = () => fail("This draft link is not valid", 400, PORTAL_RESUME_CODES.DRAFT_INVALID);
    if (!token) throw draftInvalid();
    const draft = await prisma.applicationDraft.findFirst({
        where: { tokenHash: hashDraftToken(token), tenantId },
        select: { id: true, submittedAt: true, expiresAt: true, candidate: { select: { anonymizedAt: true, status: true } } },
    });
    if (!draft || draft.submittedAt || new Date(draft.expiresAt).getTime() <= now.getTime()) throw draftInvalid();
    if (!draft.candidate || draft.candidate.anonymizedAt || draft.candidate.status !== "active") throw draftInvalid();
    return draft;
}

/**
 * Store the visitor's resume and return its reference. `draftToken` (the
 * emailed draft link's token) binds the reference to that draft.
 *
 * @returns {Promise<{ resumeRef: string, fileName: string, size: number, expiresAt: string, boundToDraft: boolean }>}
 */
export async function uploadPortalResume({ tenantId, resume, draftToken = null, now = new Date() } = {}) {
    if (!isRecruitmentFlagEnabled("portal")) {
        // The same 404 as an unknown job (§3.4: no oracle for the flag).
        throw Object.assign(new Error("Not found"), { status: 404, code: "HR-PORTAL-NOT-FOUND" });
    }
    if (!tenantId) throw unavailable();
    const file = validatePortalResume(resume);
    // Everything that can refuse runs before the file reaches DAM.
    assertPortalResumeRefsAvailable();
    const draft = draftToken != null && draftToken !== "" ? await draftForUpload({ tenantId, draftToken, now }) : null;

    let uploaded = null;
    try {
        uploaded = await uploadFileToDAM({ buffer: file.buffer, mimetype: file.mimeType, originalname: file.fileName }, "document");
    } catch {
        uploaded = null;
    }
    const mediaId = positiveInt(Array.isArray(uploaded) ? uploaded[0]?.id : uploaded?.id);
    if (!mediaId) {
        log.warn({ tenantId, size: file.size }, "portal resume upload: DAM stored nothing");
        throw fail("The resume could not be stored; please try again", 503, PORTAL_RESUME_CODES.UNAVAILABLE);
    }
    const { resumeRef, expiresAt } = issuePortalResumeRef({ tenantId, mediaId, fileName: file.fileName, draftId: draft?.id ?? null, now });
    log.info({ tenantId, mediaId, draftId: draft?.id ?? null, size: file.size }, "portal resume stored");
    return { resumeRef, fileName: file.fileName, size: file.size, expiresAt: expiresAt.toISOString(), boundToDraft: Boolean(draft) };
}

/**
 * The trusted media id for a direct application (POST /jobs/:id/apply): only
 * a reference of this tenant that is not bound to a draft (a draft-bound one
 * belongs to that draft's submit). null when none was sent.
 */
export function resumeMediaIdForApply({ tenantId, body = {}, now = new Date() } = {}) {
    // Portal off: the intake answers its uniform 404 before any resume check.
    if (!isRecruitmentFlagEnabled("portal")) return null;
    if (body?.resumeMediaId != null && body.resumeMediaId !== "") throw unverifiedResume();
    if (body?.resumeRef == null || body.resumeRef === "") return null;
    const ref = readPortalResumeRef(body.resumeRef, { tenantId, now });
    if (ref.draftId) {
        throw fail("This resume was uploaded for a saved draft; submit the draft instead", 400, PORTAL_RESUME_CODES.DRAFT_MISMATCH);
    }
    return ref.mediaId;
}

/** A typed media id is never attached: the file goes through the upload. */
export const unverifiedResume = () =>
    fail("Upload the resume file; a media id cannot be attached", 400, PORTAL_RESUME_CODES.UNVERIFIED);
