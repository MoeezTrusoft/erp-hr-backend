// src/lib/offer-letter-template.util.js
//
// Recruitment Phase 3a — the offer letter MERGE-FIELD RENDERER. Pure: no I/O,
// no clock (the caller passes `now`), no service imports.
//
// A template is plain text with {{merge.fields}}; paragraphs are separated by a
// blank line. The rules this file holds:
//
//   * A CLOSED VOCABULARY. Only the fields in MERGE_FIELDS exist. A template
//     naming any other {{field}} is refused at save time with the allowed list
//     (validateOfferLetterTemplate), so a typo is caught by the recruiter who
//     made it, not by the candidate who reads "Dear ,".
//   * PLAIN TEXT, ONE PASS. Values are inserted literally in a single pass: a
//     value that itself looks like "{{offer.salary}}" or "<b>" is printed as
//     those characters, never expanded or interpreted. There is no HTML, no
//     markup and no escaping language; the PDF is drawn with pdfkit's text API.
//   * MISSING IS VISIBLE. A field with no value renders as an empty string and
//     is reported as a warning, so the recruiter reviewing the preview sees
//     what the letter is missing before it is sent.
//   * DATES IN THE TENANT'S ZONE. {{today}} and the offer dates are formatted
//     in the tenant's IANA time zone (recruitment settings), as "20 October 2026".

export const MERGE_FIELDS = Object.freeze([
    "candidate.firstName",
    "candidate.lastName",
    "job.title",
    "job.department",
    "offer.startDate",
    "offer.expiryDate",
    "offer.salary",
    "offer.currency",
    "offer.employmentType",
    "offer.probationMonths",
    "offer.noticePeriodDays",
    "offer.benefits",
    "company.name",
    "today",
]);

const MERGE_FIELD_SET = new Set(MERGE_FIELDS);
const DATE_FIELDS = new Set(["offer.startDate", "offer.expiryDate", "today"]);

export const MAX_TEMPLATE_BODY_BYTES = 50 * 1024;
export const MAX_TEMPLATE_SUBJECT_LENGTH = 300;
export const MAX_TEMPLATE_NAME_LENGTH = 200;
export const DEFAULT_TIME_ZONE = "Asia/Karachi";

// {{ field }} with optional inner whitespace. Braces inside a tag are not
// allowed, so "{{{x}}}" leaves a stray brace that the malformed check reports.
const TAG_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

const invalid = (message, details) =>
    Object.assign(new Error(message), { status: 422, code: "HR-RECRUITMENT-OFFER-LETTER-TEMPLATE-INVALID", details });

/** The merge fields a text names, in order of first appearance. */
export function extractMergeFields(text) {
    const seen = [];
    for (const match of String(text ?? "").matchAll(TAG_RE)) {
        if (!seen.includes(match[1])) seen.push(match[1]);
    }
    return seen;
}

function assertFieldsKnown(text, label) {
    const unknown = extractMergeFields(text).filter((f) => !MERGE_FIELD_SET.has(f));
    if (unknown.length) {
        throw invalid(
            `The ${label} uses unknown merge fields: ${unknown.map((f) => `{{${f}}}`).join(", ")}. ` +
            `Allowed fields: ${MERGE_FIELDS.map((f) => `{{${f}}}`).join(", ")}`,
            { unknownFields: unknown, allowedFields: [...MERGE_FIELDS] },
        );
    }
    // What is left once every tag is removed must hold no "{{" or "}}": an
    // unclosed tag would otherwise print as literal braces in the letter.
    const rest = String(text ?? "").replace(TAG_RE, "");
    if (rest.includes("{{") || rest.includes("}}")) {
        throw invalid(`The ${label} has a malformed merge field (unbalanced {{ or }})`, {
            allowedFields: [...MERGE_FIELDS],
        });
    }
}

/**
 * Validate (and trim) a template payload. Throws 422
 * HR-RECRUITMENT-OFFER-LETTER-TEMPLATE-INVALID; returns { name, subject, body }.
 */
export function validateOfferLetterTemplate({ name, subject, body } = {}) {
    const cleanName = String(name ?? "").trim();
    if (!cleanName) throw invalid("name is required");
    if (cleanName.length > MAX_TEMPLATE_NAME_LENGTH) {
        throw invalid(`name must be at most ${MAX_TEMPLATE_NAME_LENGTH} characters`);
    }
    const cleanSubject = subject == null ? null : String(subject).trim() || null;
    if (cleanSubject && cleanSubject.length > MAX_TEMPLATE_SUBJECT_LENGTH) {
        throw invalid(`subject must be at most ${MAX_TEMPLATE_SUBJECT_LENGTH} characters`);
    }
    const text = normalizeNewlines(body);
    if (!text.trim()) throw invalid("body is required");
    if (Buffer.byteLength(text, "utf8") > MAX_TEMPLATE_BODY_BYTES) {
        throw invalid(`body must be at most ${MAX_TEMPLATE_BODY_BYTES / 1024} KB`);
    }
    if (cleanSubject) assertFieldsKnown(cleanSubject, "subject");
    assertFieldsKnown(text, "body");
    return { name: cleanName, subject: cleanSubject, body: text };
}

/** Template keys are upper-case words: STANDARD, CONTRACT, INTERNSHIP... */
export function normalizeTemplateKey(raw) {
    const key = String(raw ?? "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return /^[A-Z][A-Z0-9_]{0,39}$/.test(key) ? key : null;
}

function normalizeNewlines(text) {
    return String(text ?? "").replace(/\r\n?/g, "\n");
}

// A merge value is one line of text: control characters (including newlines)
// become spaces so a value cannot inject paragraphs into the letter.
function cleanValue(value) {
    // eslint-disable-next-line no-control-regex
    return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function isBlank(value) {
    return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/** "20 October 2026" in the given IANA zone; null for no or a bad date. */
export function formatLetterDate(value, timeZone = DEFAULT_TIME_ZONE) {
    if (isBlank(value)) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    try {
        return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long", year: "numeric" }).format(date);
    } catch {
        return new Intl.DateTimeFormat("en-GB", { timeZone: DEFAULT_TIME_ZONE, day: "numeric", month: "long", year: "numeric" }).format(date);
    }
}

function formatAmount(value) {
    if (isBlank(value)) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}

function formatList(value) {
    if (Array.isArray(value)) {
        const items = value.map((v) => (isBlank(v) ? "" : cleanValue(v))).filter(Boolean);
        return items.length ? items.join(", ") : null;
    }
    return isBlank(value) ? null : value;
}

function lookup(context, field) {
    if (field === "today") return context?.today;
    const [group, key] = field.split(".");
    return context?.[group]?.[key];
}

/**
 * Turn the raw letter context into display strings, one per merge field.
 * `context` is { candidate, job, offer, company } with plain values (dates as
 * Date or ISO, salary as a number); `now` fills {{today}}.
 * @returns {Record<string, string|null>} null = no value
 */
export function buildMergeValues(context = {}, { timeZone = DEFAULT_TIME_ZONE, now } = {}) {
    const values = {};
    const withToday = { ...context, today: context.today ?? now ?? null };
    for (const field of MERGE_FIELDS) {
        const raw = lookup(withToday, field);
        let shown;
        if (DATE_FIELDS.has(field)) shown = formatLetterDate(raw, timeZone);
        else if (field === "offer.salary") shown = formatAmount(raw);
        else if (field === "offer.benefits") shown = formatList(raw);
        else shown = isBlank(raw) ? null : raw;
        values[field] = shown === null || shown === undefined ? null : cleanValue(shown);
    }
    return values;
}

/**
 * Render a template against merge values (buildMergeValues output).
 * @returns {{ subject: string|null, text: string, paragraphs: string[], warnings: Array<{field:string, reason:string}> }}
 */
export function renderOfferLetter({ subject = null, body = "" } = {}, values = {}) {
    const missing = [];
    const substitute = (text) =>
        normalizeNewlines(text).replace(TAG_RE, (_whole, field) => {
            const value = MERGE_FIELD_SET.has(field) ? values[field] : null;
            if (value === null || value === undefined || value === "") {
                if (!missing.includes(field)) missing.push(field);
                return "";
            }
            return String(value);
        });

    const renderedSubject = subject ? substitute(subject).replace(/\s+/g, " ").trim() || null : null;
    const paragraphs = substitute(body)
        .split(/\n[ \t]*\n/)
        .map((p) => p.replace(/[ \t]+$/gm, "").trim())
        .filter(Boolean);
    return {
        subject: renderedSubject,
        text: paragraphs.join("\n\n"),
        paragraphs,
        warnings: missing.map((field) => ({ field, reason: "MISSING_VALUE" })),
    };
}
