// src/lib/onboarding-upload.util.js
//
// Recruitment Phase 4 — the rules for a document a NEW HIRE uploads through the
// pre-boarding portal (pure: no DB, no I/O).
//
// The new hire is not an HR user: whatever they send is untrusted. So a file is
// accepted only when every one of these agrees:
//   * the declared MIME type is one of PDF, JPEG or PNG;
//   * the file name's extension belongs to that MIME type;
//   * the base64 is well formed (canonical alphabet, correct padding);
//   * the decoded size is at most 10 MB (checked from the base64 length BEFORE
//     decoding, so an oversized payload is never materialised);
//   * the first bytes are that format's signature (a renamed .exe declared as
//     application/pdf is refused).
// The file name is cleaned for storage and display: no path parts, no control
// or shell-special characters, a bounded length, and the extension kept.

export const ONBOARDING_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

// Largest base64 text that can decode to MAX_BYTES (4 chars per 3 bytes).
export const ONBOARDING_UPLOAD_MAX_BASE64_LENGTH = Math.ceil(ONBOARDING_UPLOAD_MAX_BYTES / 3) * 4;

export const ONBOARDING_UPLOAD_FILE_NAME_MAX_LENGTH = 120;

// MIME type -> allowed extensions and the leading byte signature.
const TYPES = Object.freeze({
    "application/pdf": Object.freeze({ extensions: Object.freeze(["pdf"]), signature: [0x25, 0x50, 0x44, 0x46, 0x2d] }), // %PDF-
    "image/jpeg": Object.freeze({ extensions: Object.freeze(["jpg", "jpeg"]), signature: [0xff, 0xd8, 0xff] }),
    "image/png": Object.freeze({ extensions: Object.freeze(["png"]), signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }),
});

export const ONBOARDING_UPLOAD_MIME_TYPES = Object.freeze(Object.keys(TYPES));
export const ONBOARDING_UPLOAD_EXTENSIONS = Object.freeze(Object.values(TYPES).flatMap((t) => t.extensions));

const fail = (message, code) => Object.assign(new Error(message), { status: 400, code });

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Lower-cased MIME type without parameters ("Image/PNG; x=1" -> "image/png"). */
export function normalizeMimeType(mimeType) {
    return String(mimeType ?? "").split(";")[0].trim().toLowerCase();
}

/** The extension of a file name, lower case, without the dot ("" when none). */
export function fileExtension(fileName) {
    const base = String(fileName ?? "").split(/[\\/]/).pop();
    const dot = base.lastIndexOf(".");
    return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

// C0 and C1 control characters (and DEL) never belong in a file name.
const stripControlCharacters = (s) =>
    Array.from(s).filter((ch) => {
        const c = ch.codePointAt(0);
        return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f));
    }).join("");

/**
 * Clean a client file name for storage: the last path segment only, control
 * and unsafe characters replaced, whitespace collapsed, at most 120 characters
 * with the extension kept. Falls back to "document.<ext>".
 * @param {string} fileName
 * @param {string} [fallbackExtension]
 * @returns {string}
 */
export function cleanFileName(fileName, fallbackExtension = "") {
    // Whitespace (tabs included) becomes one space before control characters go.
    const base = stripControlCharacters(String(fileName ?? "").split(/[\\/]/).pop().normalize("NFKC").replace(/\s+/g, " "))
        .replace(/[<>:"|?*`$;&{}[\]^%#~'!=]/g, "_")
        .trim();
    // Split at the last dot first, so "....png" keeps its extension.
    const dot = base.lastIndexOf(".");
    const rawExt = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
    const ext = /^[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : "";
    let stem = ext ? base.slice(0, dot) : base;
    // No hidden files, no trailing dots or spaces (Windows strips them).
    stem = stem.replace(/^[.\s_-]+/, "").replace(/[.\s]+$/, "");
    if (!stem) stem = "document";
    const extension = ext || String(fallbackExtension || "").toLowerCase();
    const suffix = extension ? `.${extension}` : "";
    const room = Math.max(1, ONBOARDING_UPLOAD_FILE_NAME_MAX_LENGTH - suffix.length);
    return `${stem.slice(0, room).trimEnd()}${suffix}`;
}

/** Decoded byte count of a canonical base64 string, without decoding it. */
export function base64DecodedLength(b64) {
    const s = String(b64 ?? "");
    if (!s) return 0;
    const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
    return (s.length / 4) * 3 - padding;
}

const startsWith = (buffer, signature) =>
    buffer.length >= signature.length && signature.every((byte, i) => buffer[i] === byte);

/**
 * Validate a portal upload and decode it.
 * @param {{ fileName: string, mimeType: string, contentBase64: string }} input
 * @returns {{ buffer: Buffer, mimeType: string, fileName: string, extension: string, size: number }}
 * @throws 400 HR-ONBOARDING-UPLOAD-* on any rule
 */
export function validateOnboardingUpload({ fileName, mimeType, contentBase64 } = {}) {
    const mime = normalizeMimeType(mimeType);
    const type = TYPES[mime];
    if (!type) {
        throw fail("Upload a PDF, JPEG or PNG file", "HR-ONBOARDING-UPLOAD-TYPE");
    }
    const ext = fileExtension(fileName);
    if (!type.extensions.includes(ext)) {
        throw fail(`The file name must end in .${type.extensions.join(" or .")} for ${mime}`, "HR-ONBOARDING-UPLOAD-EXTENSION");
    }
    if (typeof contentBase64 !== "string") {
        throw fail("The file content is required", "HR-ONBOARDING-UPLOAD-CONTENT");
    }
    // Line breaks are tolerated (MIME-style wrapping); nothing else is.
    const b64 = contentBase64.replace(/[\r\n]+/g, "");
    if (b64.length > ONBOARDING_UPLOAD_MAX_BASE64_LENGTH) {
        throw fail("The file is larger than 10 MB", "HR-ONBOARDING-UPLOAD-TOO-LARGE");
    }
    if (!b64 || b64.length % 4 !== 0 || !BASE64.test(b64)) {
        throw fail("The file content is not valid base64", "HR-ONBOARDING-UPLOAD-CONTENT");
    }
    const size = base64DecodedLength(b64);
    if (size <= 0) throw fail("The file is empty", "HR-ONBOARDING-UPLOAD-CONTENT");
    if (size > ONBOARDING_UPLOAD_MAX_BYTES) {
        throw fail("The file is larger than 10 MB", "HR-ONBOARDING-UPLOAD-TOO-LARGE");
    }
    const buffer = Buffer.from(b64, "base64");
    if (!startsWith(buffer, type.signature)) {
        throw fail(`The file content is not a ${mime === "application/pdf" ? "PDF" : mime === "image/png" ? "PNG" : "JPEG"} file`, "HR-ONBOARDING-UPLOAD-SIGNATURE");
    }
    return { buffer, mimeType: mime, fileName: cleanFileName(fileName, ext), extension: ext, size: buffer.length };
}
