// src/services/recruitment-document-download.service.js
//
// Recruitment Phase 7 (B7) — the DAM READ path for recruitment documents.
// Offer letter PDFs, interview packet documents and test item pictures are
// stored in DAM, and until now no screen could open them. Each record's own
// service decides WHO may open WHICH media (the offer read rules, the packet
// view, the item bank visibility) and checks the media belongs to that record
// in that tenant; this module then does the one thing they share: read the
// bytes from DAM and hand them back in the shape the Phase 6 onboarding
// download uses ({ fileName, mimeType, size, contentBase64 }).
//
// Rules:
//   * nothing reaches DAM before the record check passed (callers pass only a
//     media id they have just matched to the record);
//   * a DAM outage (no bytes, a throw) is 502 HR-RECRUITMENT-DOCUMENT-
//     UNAVAILABLE, which clients see as HR-5032 (retryable);
//   * the same 15 MB cap as the onboarding download: a bigger asset is
//     refused (413) rather than pushed through one JSON-RPC answer;
//   * the MIME type comes from the leading bytes when they are a PDF, PNG,
//     JPEG, GIF or WebP; DAM's content type only otherwise (a presigned URL
//     often answers application/octet-stream).
import logger from "../lib/logger.js";
import { cleanFileName, fileExtension, normalizeMimeType } from "../lib/onboarding-upload.util.js";
import { downloadDamAssetBuffer } from "./dam.media.service.js";

// Same cap as hr_self_onboarding_document_download (DOCUMENT_DOWNLOAD_MAX_BYTES).
export const RECRUITMENT_DOWNLOAD_MAX_BYTES = 15 * 1024 * 1024;

export const DOCUMENT_UNAVAILABLE_CODE = "HR-RECRUITMENT-DOCUMENT-UNAVAILABLE";
export const DOCUMENT_TOO_LARGE_CODE = "HR-RECRUITMENT-DOCUMENT-TOO-LARGE";

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const SNIFFED_TYPES = Object.freeze([
    { mimeType: "application/pdf", extension: "pdf", signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
    { mimeType: "image/png", extension: "png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mimeType: "image/jpeg", extension: "jpg", signature: [0xff, 0xd8, 0xff] },
    { mimeType: "image/gif", extension: "gif", signature: [0x47, 0x49, 0x46, 0x38] },
]);

/** The type of a buffer from its leading bytes, or null. */
export function sniffDocumentType(buffer) {
    if (!buffer?.length) return null;
    const known = SNIFFED_TYPES.find((t) => buffer.length >= t.signature.length && t.signature.every((b, i) => buffer[i] === b));
    if (known) return known;
    // WebP: "RIFF" .... "WEBP"
    if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
        return { mimeType: "image/webp", extension: "webp" };
    }
    return null;
}

// DAM's own name when it is a real one ("asset-<id>" is its placeholder),
// else the caller's fallback; always cleaned, always with an extension.
function downloadName(damFileName, fallbackName, extension) {
    const fromDam = typeof damFileName === "string" && !/^asset-\d+$/.test(damFileName) && fileExtension(damFileName)
        ? damFileName
        : null;
    return cleanFileName(fromDam ?? fallbackName ?? "document", extension);
}

/**
 * Read one DAM asset the caller has already been allowed to open.
 * @param {object} p
 * @param {number} p.mediaId       the DAM asset id, matched to its record by the caller
 * @param {string} [p.fallbackName] the file name when DAM has none
 * @param {object} [p.log]          ids for the warning log (never names or content)
 * @returns {Promise<{ fileName: string, mimeType: string, size: number, contentBase64: string }>}
 */
export async function readRecruitmentDocument({ mediaId, fallbackName = "document", log = {} } = {}) {
    const id = Number(mediaId);
    if (!Number.isInteger(id) || id <= 0) throw fail("Document not found", 404, "HR-RECRUITMENT-DOCUMENT-NOT-FOUND");

    // DAM reads are fail-soft (null on failure); a throw is treated the same.
    const file = await downloadDamAssetBuffer(id).catch(() => null);
    const buffer = file?.buffer;
    if (!buffer?.length) {
        logger.warn({ ...log, mediaId: id }, "recruitment document download: DAM returned no content");
        throw fail("The document could not be read just now; please try again", 502, DOCUMENT_UNAVAILABLE_CODE);
    }
    if (buffer.length > RECRUITMENT_DOWNLOAD_MAX_BYTES) {
        throw fail("This document is too large to open here", 413, DOCUMENT_TOO_LARGE_CODE);
    }

    const sniffed = sniffDocumentType(buffer);
    const damType = normalizeMimeType(file.mimeType);
    const mimeType = sniffed?.mimeType ?? (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(damType) ? damType : "application/octet-stream");
    return {
        fileName: downloadName(file.fileName, fallbackName, sniffed?.extension ?? ""),
        mimeType,
        size: buffer.length,
        contentBase64: buffer.toString("base64"),
    };
}
