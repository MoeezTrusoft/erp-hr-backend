// src/lib/test-item.util.js
//
// Phase 3b — the test item bank's pure rules: what a well-formed item is, how
// its rich text is cleaned, how its stable code is derived, which lifecycle
// moves are allowed, and how an AI plane answer is turned into item drafts.
// No DB, no I/O: the services (test-item*.service.js) call these before every
// write, so the bulk import, the AI drafts and the editor all land the same
// shape.
//
// Item shapes (the answer key is the server's and never leaves it):
//   SINGLE, IMAGE_SINGLE  2 to 6 options, key { optionIds: [one id] }
//                         (IMAGE_SINGLE also needs the DAM image, mediaId)
//   MULTI                 2 to 6 options, key { optionIds: [one or more] },
//                         scoringRule { multi: ALL_OR_NOTHING | PARTIAL }
//   TRUE_FALSE            exactly the options "true" and "false", one correct
//   NUMERIC               no options, key { value, tolerance >= 0 }
// The key shapes are the ones src/lib/test-scoring.util.js scores.
//
// Rich text: stems, options and feedback allow p, br, strong, em, ul, ol, li,
// code and pre, with no attributes at all. Everything else is stripped (the
// content of script-like elements is dropped with it) and any "<" that does
// not open a well-formed tag is escaped, so the stored text is safe to render
// as HTML without another sanitiser.
import { createHash } from "node:crypto";

import { ITEM_TYPES } from "./test-scoring.util.js";
import { normalizeJobFamily } from "./test-blueprint.util.js";

export { ITEM_TYPES };

export const ITEM_STATUS = Object.freeze({
    DRAFT: "DRAFT",
    IN_REVIEW: "IN_REVIEW",
    PUBLISHED: "PUBLISHED",
    RETIRED: "RETIRED",
});
export const ITEM_DIFFICULTIES = Object.freeze(["EASY", "MEDIUM", "HARD"]);
export const ITEM_LANGUAGES = Object.freeze(["en", "ur"]);
export const MULTI_SCORING_RULES = Object.freeze(["ALL_OR_NOTHING", "PARTIAL"]);
export const CHOICE_ITEM_TYPES = Object.freeze(["SINGLE", "MULTI", "TRUE_FALSE", "IMAGE_SINGLE"]);
const ONE_KEY_TYPES = Object.freeze(["SINGLE", "TRUE_FALSE", "IMAGE_SINGLE"]);
export const TRUE_FALSE_OPTION_IDS = Object.freeze(["true", "false"]);

export const ITEM_LIMITS = Object.freeze({
    minOptions: 2,
    maxOptions: 6,
    stemMax: 5000,
    optionMax: 1000,
    feedbackMax: 1000,
    rationaleMax: 5000,
    jobFamilyMax: 80,
    gradeLevelsMax: 20,
    timeMinSec: 5,
    timeMaxSec: 3600,
    rawHtmlMax: 20000,
});

// Lifecycle: DRAFT -> IN_REVIEW (submit), IN_REVIEW -> PUBLISHED (publish) or
// back to DRAFT (return), anything but RETIRED -> RETIRED. RETIRED is final.
const TRANSITIONS = Object.freeze({
    DRAFT: Object.freeze(["IN_REVIEW", "RETIRED"]),
    IN_REVIEW: Object.freeze(["PUBLISHED", "DRAFT", "RETIRED"]),
    PUBLISHED: Object.freeze(["RETIRED"]),
    RETIRED: Object.freeze([]),
});

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

/** May an item move from one status to another? */
export function canTransition(from, to) {
    return (TRANSITIONS[from] ?? []).includes(to);
}

/** Throw a 409 unless the move is allowed. */
export function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw fail(`A ${from} item cannot become ${to}`, 409, "HR-RECRUITMENT-TEST-ITEM-STATE", { from, to });
    }
}

// ── Rich text ────────────────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set(["p", "br", "strong", "em", "ul", "ol", "li", "code", "pre"]);
// Elements whose CONTENT is dropped along with the tag: their text is code,
// markup or a nested document, never prose an item author meant to show.
const DROP_CONTENT_TAGS = new Set([
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template",
    "textarea", "title", "xmp", "noembed", "noframes", "plaintext", "svg", "math", "select", "head",
]);
const MAX_DEPTH = 20;
// A well-formed start or end tag at the current position (sticky): a name,
// then attributes with optional quoted or bare values, then an optional "/".
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g; // eslint-disable-line no-control-regex
// A bare "&" that does not start a character reference.
const BARE_AMP_RE = /&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});)/g;

const escapeText = (text) => text.replace(BARE_AMP_RE, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Index just past the end tag of a drop-content element, or the end of input.
function skipElementContent(html, from, name) {
    const close = new RegExp(`</${name}(?=[\\s/>])`, "ig");
    close.lastIndex = from;
    const hit = close.exec(html);
    if (!hit) return html.length;
    const end = html.indexOf(">", hit.index);
    return end === -1 ? html.length : end + 1;
}

/**
 * Clean author or AI supplied rich text down to the safe subset.
 * @param {unknown} value
 * @returns {string} sanitised HTML (may be empty)
 */
export function sanitizeRichText(value) {
    if (value === null || value === undefined) return "";
    const html = String(value).slice(0, ITEM_LIMITS.rawHtmlMax).replace(CONTROL_RE, "");
    const out = [];
    const stack = [];
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf("<", i);
        if (lt === -1) {
            out.push(escapeText(html.slice(i)));
            break;
        }
        out.push(escapeText(html.slice(i, lt)));
        if (html.startsWith("<!--", lt)) {
            const end = html.indexOf("-->", lt + 4);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        if (html[lt + 1] === "!" || html[lt + 1] === "?") {
            // Doctype, CDATA, processing instruction: never content.
            const end = html.indexOf(">", lt);
            i = end === -1 ? html.length : end + 1;
            continue;
        }
        TAG_RE.lastIndex = lt;
        const m = TAG_RE.exec(html);
        if (!m) {
            out.push("&lt;");
            i = lt + 1;
            continue;
        }
        i = TAG_RE.lastIndex;
        const closing = m[1] === "/";
        const name = m[2].toLowerCase();
        if (DROP_CONTENT_TAGS.has(name)) {
            if (!closing && m[4] !== "/") i = skipElementContent(html, i, name);
            continue;
        }
        if (!ALLOWED_TAGS.has(name)) continue;
        if (name === "br") {
            if (!closing) out.push("<br>");
            continue;
        }
        if (!closing) {
            if (m[4] === "/" || stack.length >= MAX_DEPTH) continue;
            // An unclosed <li> or <p> ends where the next one starts, as in HTML.
            if ((name === "li" || name === "p") && stack[stack.length - 1] === name) out.push(`</${stack.pop()}>`);
            stack.push(name);
            out.push(`<${name}>`);
            continue;
        }
        const at = stack.lastIndexOf(name);
        if (at === -1) continue;
        while (stack.length > at) out.push(`</${stack.pop()}>`);
    }
    while (stack.length) out.push(`</${stack.pop()}>`);
    return out.join("").trim();
}

/** The visible text of sanitised rich text (for emptiness checks and search). */
export function richTextToPlain(html) {
    return String(html ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// ── Codes and keys ───────────────────────────────────────────────────────────

/**
 * Normalise a competency key: trimmed, lower case, inner whitespace as "-".
 * Blueprint sections match items on this exact form.
 */
export function normalizeCompetencyKey(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}
const COMPETENCY_RE = /^[a-z0-9؀-ۿ][a-z0-9؀-ۿ._:-]{0,79}$/;
const ITEM_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,59}$/;
const OPTION_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * The stable code every version of an item shares. Derived from the content
 * the author first wrote, so importing the same row twice finds the same code
 * (and is refused as a duplicate) instead of creating a second item.
 */
export function itemCodeFor({ competencyKey, type, stem, language = "en" }) {
    const prefix = normalizeCompetencyKey(competencyKey).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "ITEM";
    const digest = createHash("sha256")
        .update([normalizeCompetencyKey(competencyKey), String(type ?? ""), String(language ?? ""), richTextToPlain(stem).toLowerCase()].join("\u001f"))
        .digest("hex")
        .slice(0, 10)
        .toUpperCase();
    return `TI-${prefix}-${digest}`;
}

/** Normalise a caller supplied item code, or null when it is not valid. */
export function normalizeItemCode(value) {
    const code = String(value ?? "").trim().toUpperCase();
    return ITEM_CODE_RE.test(code) ? code : null;
}

/** The stored (C4-decrypted) answer key text as an object, or null. */
export function decodeAnswerKey(text) {
    if (text === null || text === undefined || text === "") return null;
    if (typeof text === "object") return text;
    try {
        const parsed = JSON.parse(String(text));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// ── Item normalisation ───────────────────────────────────────────────────────

const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const upper = (v) => String(v ?? "").trim().toUpperCase();

function optionalInt(value, field, errors, { min, max }) {
    if (isBlank(value)) return null;
    const n = typeof value === "string" ? Number(value.trim()) : value;
    if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
        errors.push({ field, message: max !== undefined ? `${field} must be a whole number from ${min} to ${max}` : `${field} must be a whole number of at least ${min}` });
        return null;
    }
    return n;
}

function richField(value, field, max, errors, { required }) {
    const clean = sanitizeRichText(value);
    if (!richTextToPlain(clean)) {
        if (required) errors.push({ field, message: `${field} is required` });
        return null;
    }
    if (clean.length > max) {
        errors.push({ field, message: `${field} must be at most ${max} characters` });
        return null;
    }
    return clean;
}

function normalizeOptions(raw, type, errors) {
    if (type === "NUMERIC") {
        if (Array.isArray(raw) && raw.length) errors.push({ field: "options", message: "A NUMERIC item has no options" });
        else if (!isBlank(raw) && !Array.isArray(raw)) errors.push({ field: "options", message: "options must be a list" });
        return null;
    }
    let list = raw;
    if (type === "TRUE_FALSE" && (isBlank(list) || (Array.isArray(list) && !list.length))) {
        list = [{ id: "true", text: "True" }, { id: "false", text: "False" }];
    }
    if (!Array.isArray(list)) {
        errors.push({ field: "options", message: "options must be a list" });
        return null;
    }
    if (list.length < ITEM_LIMITS.minOptions || list.length > ITEM_LIMITS.maxOptions) {
        errors.push({ field: "options", message: `An item has ${ITEM_LIMITS.minOptions} to ${ITEM_LIMITS.maxOptions} options` });
        return null;
    }
    const options = [];
    const seen = new Set();
    list.forEach((entry, index) => {
        const option = entry !== null && typeof entry === "object" ? entry : { text: entry };
        let id = isBlank(option.id) ? String.fromCharCode(97 + index) : String(option.id).trim();
        if (type === "TRUE_FALSE") id = id.toLowerCase();
        if (!OPTION_ID_RE.test(id)) {
            errors.push({ field: `options[${index}].id`, message: "An option id is 1 to 16 letters, digits, '-' or '_'" });
            return;
        }
        if (seen.has(id.toLowerCase())) {
            errors.push({ field: `options[${index}].id`, message: `Option id "${id}" is used twice` });
            return;
        }
        seen.add(id.toLowerCase());
        const text = richField(option.text, `options[${index}].text`, ITEM_LIMITS.optionMax, errors, { required: true });
        const feedback = isBlank(option.feedback) ? null : richField(option.feedback, `options[${index}].feedback`, ITEM_LIMITS.feedbackMax, errors, { required: false });
        if (text !== null) options.push(feedback ? { id, text, feedback } : { id, text });
    });
    if (type === "TRUE_FALSE") {
        const ids = options.map((o) => o.id).sort();
        if (options.length !== 2 || ids[0] !== "false" || ids[1] !== "true") {
            errors.push({ field: "options", message: "A TRUE_FALSE item has exactly the options true and false" });
        }
    }
    return options.length === list.length ? options : null;
}

function normalizeChoiceKey(raw, type, options, errors) {
    const key = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    let ids = Array.isArray(key.optionIds) ? key.optionIds : !isBlank(key.optionId) ? [key.optionId] : [];
    ids = ids.map((id) => String(id).trim()).filter(Boolean);
    if (type === "TRUE_FALSE") ids = ids.map((id) => id.toLowerCase());
    if (new Set(ids).size !== ids.length) {
        errors.push({ field: "answerKey", message: "The answer key lists an option twice" });
        return null;
    }
    if (ONE_KEY_TYPES.includes(type) && ids.length !== 1) {
        errors.push({ field: "answerKey", message: `A ${type} item has exactly one correct option` });
        return null;
    }
    if (type === "MULTI" && !ids.length) {
        errors.push({ field: "answerKey", message: "A MULTI item has at least one correct option" });
        return null;
    }
    if (!options) return null;
    const known = new Set(options.map((o) => o.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) {
        errors.push({ field: "answerKey", message: `The answer key names options that do not exist: ${unknown.join(", ")}` });
        return null;
    }
    return { optionIds: ids };
}

function normalizeNumericKey(raw, errors) {
    const key = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const value = typeof key.value === "string" && key.value.trim() !== "" ? Number(key.value) : key.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push({ field: "answerKey.value", message: "A NUMERIC item needs a finite answer value" });
        return null;
    }
    const rawTol = isBlank(key.tolerance) ? 0 : key.tolerance;
    const tolerance = typeof rawTol === "string" ? Number(rawTol) : rawTol;
    if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) {
        errors.push({ field: "answerKey.tolerance", message: "The tolerance must be a number of zero or more" });
        return null;
    }
    return { value, tolerance };
}

function normalizeGradeLevels(raw, errors) {
    if (isBlank(raw)) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const ids = [...new Set(list.map((v) => (typeof v === "string" ? Number(v.trim()) : v)))];
    if (ids.some((n) => !Number.isInteger(n) || n <= 0) || ids.length > ITEM_LIMITS.gradeLevelsMax) {
        errors.push({ field: "gradeLevelIds", message: `gradeLevelIds lists up to ${ITEM_LIMITS.gradeLevelsMax} grade level ids` });
        return [];
    }
    return ids;
}

function normalizeBoolean(raw, field, errors) {
    if (isBlank(raw)) return false;
    if (typeof raw === "boolean") return raw;
    errors.push({ field, message: `${field} must be true or false` });
    return false;
}

/**
 * Validate and normalise one item. Never throws.
 * @param {object} input  the editor, import row or AI draft shape
 * @returns {{ ok: boolean, value: object|null, errors: Array<{ field: string, message: string }> }}
 */
export function normalizeItemInput(input) {
    const errors = [];
    const src = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};

    const type = upper(src.type);
    if (!ITEM_TYPES.includes(type)) {
        errors.push({ field: "type", message: `type must be one of ${ITEM_TYPES.join(", ")}` });
        return { ok: false, value: null, errors };
    }
    const stem = richField(src.stem, "stem", ITEM_LIMITS.stemMax, errors, { required: true });
    const options = normalizeOptions(src.options, type, errors);
    const answerKey = type === "NUMERIC" ? normalizeNumericKey(src.answerKey, errors) : normalizeChoiceKey(src.answerKey, type, options, errors);

    let scoringRule = null;
    if (type === "MULTI") {
        const rule = isBlank(src.scoringRule?.multi) ? "ALL_OR_NOTHING" : upper(src.scoringRule.multi);
        if (!MULTI_SCORING_RULES.includes(rule)) errors.push({ field: "scoringRule.multi", message: `scoringRule.multi must be one of ${MULTI_SCORING_RULES.join(", ")}` });
        scoringRule = { multi: rule };
    }

    const mediaId = optionalInt(src.mediaId, "mediaId", errors, { min: 1 });
    if (type === "IMAGE_SINGLE" && mediaId === null && !errors.some((e) => e.field === "mediaId")) {
        errors.push({ field: "mediaId", message: "An IMAGE_SINGLE item needs its DAM image (mediaId)" });
    }

    const difficulty = upper(src.difficulty);
    if (!ITEM_DIFFICULTIES.includes(difficulty)) errors.push({ field: "difficulty", message: `difficulty must be one of ${ITEM_DIFFICULTIES.join(", ")}` });

    const competencyKey = normalizeCompetencyKey(src.competencyKey);
    if (!competencyKey) errors.push({ field: "competencyKey", message: "competencyKey is required" });
    else if (!COMPETENCY_RE.test(competencyKey)) errors.push({ field: "competencyKey", message: "competencyKey is up to 80 letters, digits, '.', ':', '-' or '_'" });

    const language = isBlank(src.language) ? "en" : String(src.language).trim().toLowerCase();
    if (!ITEM_LANGUAGES.includes(language)) errors.push({ field: "language", message: `language must be one of ${ITEM_LANGUAGES.join(", ")}` });

    // Stored the way blueprints store it (trimmed, upper case), so pools and draws agree.
    const jobFamily = isBlank(src.jobFamily) ? null : normalizeJobFamily(src.jobFamily);
    if (jobFamily && jobFamily.length > ITEM_LIMITS.jobFamilyMax) errors.push({ field: "jobFamily", message: `jobFamily must be at most ${ITEM_LIMITS.jobFamilyMax} characters` });

    const rationale = isBlank(src.rationale) ? null : richField(src.rationale, "rationale", ITEM_LIMITS.rationaleMax, errors, { required: false });

    let itemCode = null;
    if (!isBlank(src.itemCode)) {
        itemCode = normalizeItemCode(src.itemCode);
        if (!itemCode) errors.push({ field: "itemCode", message: "itemCode is 3 to 60 letters, digits, '-' or '_'" });
    }

    const value = {
        itemCode,
        type,
        stem,
        mediaId,
        options,
        answerKey,
        scoringRule,
        difficulty,
        competencyKey,
        skillId: optionalInt(src.skillId, "skillId", errors, { min: 1 }),
        jobFamily,
        gradeLevelIds: normalizeGradeLevels(src.gradeLevelIds, errors),
        language,
        timeEstimateSec: optionalInt(src.timeEstimateSec, "timeEstimateSec", errors, { min: ITEM_LIMITS.timeMinSec, max: ITEM_LIMITS.timeMaxSec }),
        rationale,
        discussionPrompt: normalizeBoolean(src.discussionPrompt, "discussionPrompt", errors),
        exposureCap: optionalInt(src.exposureCap, "exposureCap", errors, { min: 1 }),
    };
    if (errors.length) return { ok: false, value: null, errors };
    return { ok: true, value, errors };
}

/** Is the item ready to go to review (the rationale is the extra requirement)? */
export function reviewReadinessErrors(item) {
    return richTextToPlain(item?.rationale) ? [] : [{ field: "rationale", message: "A rationale is required before review" }];
}

// ── AI drafts ────────────────────────────────────────────────────────────────

export const AI_DRAFT_TYPES = Object.freeze(["SINGLE", "MULTI", "TRUE_FALSE", "NUMERIC"]);
export const AI_DRAFT_MAX = 10;

function draftOptions(raw) {
    if (!Array.isArray(raw)) return raw;
    return raw.map((o) => (o !== null && typeof o === "object" ? { id: o.id, text: o.text ?? o.label, feedback: o.feedback } : { text: o }));
}

function draftKey(draft, type) {
    if (draft.answerKey && typeof draft.answerKey === "object") return draft.answerKey;
    if (type === "NUMERIC") return { value: draft.value ?? draft.answer, tolerance: draft.tolerance };
    if (Array.isArray(draft.correctOptionIds)) return { optionIds: draft.correctOptionIds };
    if (!isBlank(draft.correctOptionId)) return { optionIds: [draft.correctOptionId] };
    if (typeof draft.correctAnswer === "boolean") return { optionIds: [String(draft.correctAnswer)] };
    return null;
}

/**
 * Turn the plane's answer to hr.assessment.item.draft.v1 into normalised item
 * drafts. The model's output is untrusted: only whitelisted fields are read,
 * the language is the one requested, the competency must be one requested,
 * and every draft goes through normalizeItemInput.
 *
 * @param {unknown} output  the plane's `output` (or its `result`)
 * @param {{ count: number, competencies: string[], types: string[], difficulty: string, language: string }} request
 * @returns {{ ok: boolean, drafts: object[], dropped: Array<{ index: number, reason: string }>, reason?: string }}
 */
export function parseAiDraftItems(output, request) {
    let payload = output && typeof output === "object" && !Array.isArray(output) && "result" in output ? output.result : output;
    if (typeof payload === "string") {
        try {
            payload = JSON.parse(payload);
        } catch {
            return { ok: false, drafts: [], dropped: [], reason: "The AI answer was not valid JSON" };
        }
    }
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.drafts) ? payload.drafts : null;
    if (!list) return { ok: false, drafts: [], dropped: [], reason: "The AI answer did not contain a list of items" };

    const count = Math.min(Math.max(Number(request.count) || 1, 1), AI_DRAFT_MAX);
    const competencies = new Set((request.competencies ?? []).map(normalizeCompetencyKey));
    const types = new Set(request.types?.length ? request.types : ["SINGLE"]);
    const drafts = [];
    const dropped = [];
    list.forEach((raw, index) => {
        if (drafts.length >= count) {
            dropped.push({ index, reason: "More drafts than were requested" });
            return;
        }
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
            dropped.push({ index, reason: "The draft is not an object" });
            return;
        }
        const type = upper(raw.type || [...types][0]);
        if (!types.has(type)) {
            dropped.push({ index, reason: `Type ${type || "(none)"} was not requested` });
            return;
        }
        const competencyKey = normalizeCompetencyKey(raw.competencyKey || [...competencies][0]);
        if (competencies.size && !competencies.has(competencyKey)) {
            dropped.push({ index, reason: `Competency ${competencyKey || "(none)"} was not requested` });
            return;
        }
        const result = normalizeItemInput({
            type,
            stem: raw.stem ?? raw.question,
            options: type === "NUMERIC" ? undefined : draftOptions(raw.options),
            answerKey: draftKey(raw, type),
            scoringRule: type === "MULTI" ? { multi: raw.scoringRule?.multi ?? raw.multiScoring } : undefined,
            // The requested difficulty wins: the author asked for that mix.
            difficulty: request.difficulty || raw.difficulty,
            competencyKey,
            language: request.language,
            timeEstimateSec: raw.timeEstimateSec,
            rationale: raw.rationale,
        });
        if (!result.ok) {
            dropped.push({ index, reason: result.errors.map((e) => e.message).join("; ") });
            return;
        }
        drafts.push(result.value);
    });
    return { ok: true, drafts, dropped };
}
