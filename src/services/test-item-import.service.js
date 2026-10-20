// src/services/test-item-import.service.js
//
// Recruitment Phase 3b — bulk loading the test item bank from a spreadsheet.
//
// One template layout, CSV (RFC 4180) or XLSX (first worksheet, or the one
// named "Items"), header in row 1, one item per row. Column names are matched
// case-insensitively; unknown columns are ignored and reported.
//
//   type               SINGLE | MULTI | TRUE_FALSE | NUMERIC | IMAGE_SINGLE   (required)
//   stem               question text, the safe rich text subset              (required)
//   option_a..option_f option texts (choice types); TRUE_FALSE uses the fixed
//                      options true / false (option_a / option_b relabel them)
//   feedback_a..feedback_f optional per-option feedback for the author
//   correct            the correct option letters, separated by ";" (a;c), or
//                      true / false for TRUE_FALSE
//   numeric_value      NUMERIC: the answer;   numeric_tolerance: >= 0 (default 0)
//   multi_scoring      MULTI: ALL_OR_NOTHING (default) | PARTIAL
//   difficulty         EASY | MEDIUM | HARD                                   (required)
//   competency_key     the competency, linked to the skill taxonomy           (required)
//   item_code, skill_id, job_family, grade_level_ids (ids separated by ";"),
//   language (en | ur), time_estimate_sec, rationale, discussion_prompt
//   (yes | no), exposure_cap, media_id (DAM image; required for IMAGE_SINGLE)
//
// Every row goes through normalizeItemInput: a valid row lands as a DRAFT
// authored by the caller, an invalid row is reported with its row number and
// reasons and nothing of it is written. The codes of the valid rows are
// checked against the bank and each other first, so the write is one
// transaction of new items. Dry run validates and reports without writing.
// Caps: 2 MB decoded file, 500 item rows.
import ExcelJS from "exceljs";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { assertAssessmentCapability } from "../lib/assessment-access.util.js";
import { normalizeItemInput } from "../lib/test-item.util.js";
import {
    assertOnsiteTestEnabled,
    codeForNewItem,
    findTakenCodes,
    insertDraftItems,
    linkTaxonomy,
    presentTestItemSummary,
} from "./test-item.service.js";

const log = logger.child({ component: "test-item-import" });

export const IMPORT_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxRows: 500 });
const LETTERS = Object.freeze(["a", "b", "c", "d", "e", "f"]);
export const IMPORT_COLUMNS = Object.freeze([
    "item_code", "type", "stem",
    ...LETTERS.map((l) => `option_${l}`),
    ...LETTERS.map((l) => `feedback_${l}`),
    "correct", "numeric_value", "numeric_tolerance", "multi_scoring", "difficulty", "competency_key", "skill_id",
    "job_family", "grade_level_ids", "language", "time_estimate_sec", "rationale", "discussion_prompt", "exposure_cap", "media_id",
]);
const REQUIRED_COLUMNS = Object.freeze(["type", "stem", "difficulty", "competency_key"]);
// Any physical record beyond this many is refused before validation (the
// 500-row cap counts non-blank rows; this bounds the work on a padded sheet).
const MAX_RECORDS = 5000;

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

// ── CSV (RFC 4180) ───────────────────────────────────────────────────────────

const csvError = (record, message) =>
    fail(`CSV record ${record}: ${message}`, 400, "HR-RECRUITMENT-TEST-ITEM-IMPORT-FILE-INVALID", { record });

/**
 * Parse RFC 4180 CSV: comma separated, CRLF or LF records, fields optionally
 * enclosed in double quotes (which may hold commas, quotes doubled as "" and
 * line breaks). A quote inside an unquoted field, text after a closing quote
 * and an unterminated quote are errors.
 * @returns {string[][]} the records
 */
export function parseCsv(text) {
    const src = String(text ?? "").replace(/^﻿/, "");
    const records = [];
    let record = [];
    let field = "";
    let quoted = false;
    let i = 0;
    const endField = () => {
        record.push(field);
        field = "";
    };
    const endRecord = () => {
        endField();
        records.push(record);
        record = [];
        if (records.length > MAX_RECORDS) throw csvError(records.length, `more than ${MAX_RECORDS} records`);
    };
    while (i < src.length) {
        const c = src[i];
        if (quoted) {
            if (c !== '"') {
                field += c;
                i += 1;
            } else if (src[i + 1] === '"') {
                field += '"';
                i += 2;
            } else {
                quoted = false;
                i += 1;
                const next = src[i];
                if (next !== undefined && next !== "," && next !== "\r" && next !== "\n") throw csvError(records.length + 1, "text after a closing quote");
            }
            continue;
        }
        if (c === '"') {
            if (field !== "") throw csvError(records.length + 1, "a quote inside an unquoted field");
            quoted = true;
            i += 1;
        } else if (c === ",") {
            endField();
            i += 1;
        } else if (c === "\r" || c === "\n") {
            endRecord();
            i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
        } else {
            field += c;
            i += 1;
        }
    }
    if (quoted) throw csvError(records.length + 1, "an unterminated quoted field");
    if (field !== "" || record.length) endRecord();
    return records;
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

// One exceljs cell value as text (rich text, formula results, hyperlinks).
function cellText(value) {
    if (value === null || value === undefined) return "";
    if (Object.prototype.toString.call(value) === "[object Date]") return value.toISOString();
    if (typeof value !== "object") return String(value);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? "").join("");
    if ("result" in value) return cellText(value.result);
    if ("text" in value) return cellText(value.text);
    return "";
}

async function parseXlsx(buffer) {
    const wb = new ExcelJS.Workbook();
    try {
        await wb.xlsx.load(buffer);
    } catch {
        throw fail("The file is not a readable XLSX workbook", 400, "HR-RECRUITMENT-TEST-ITEM-IMPORT-FILE-INVALID");
    }
    const ws = wb.worksheets.find((s) => /^items$/i.test(s.name)) ?? wb.worksheets[0];
    if (!ws) throw fail("The workbook has no worksheet", 400, "HR-RECRUITMENT-TEST-ITEM-IMPORT-FILE-INVALID");
    if (ws.rowCount > MAX_RECORDS) throw fail(`The worksheet has more than ${MAX_RECORDS} rows`, 400, "HR-RECRUITMENT-TEST-ITEM-IMPORT-TOO-MANY-ROWS");
    const width = Math.min(ws.columnCount, 64);
    const records = [];
    for (let r = 1; r <= ws.rowCount; r += 1) {
        const row = ws.getRow(r);
        const cells = [];
        for (let c = 1; c <= width; c += 1) cells.push(cellText(row.getCell(c).value));
        records.push(cells);
    }
    return records;
}

// ── Records -> item inputs ───────────────────────────────────────────────────

const isXlsx = (buffer) => buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK" zip

function detectFormat(format, fileName, buffer) {
    const declared = String(format ?? "").trim().toLowerCase();
    if (declared === "csv" || declared === "xlsx") return declared;
    const ext = String(fileName ?? "").toLowerCase().match(/\.(csv|xlsx)$/)?.[1];
    if (ext) return ext;
    return isXlsx(buffer) ? "xlsx" : "csv";
}

function decodeFile(contentBase64) {
    const b64 = String(contentBase64 ?? "").replace(/\s+/g, "");
    if (!b64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw fail("The file must be base64 encoded", 400, "HR-RECRUITMENT-TEST-ITEM-IMPORT-FILE-INVALID");
    if (Math.floor((b64.length * 3) / 4) > IMPORT_LIMITS.maxBytes + 2) {
        throw fail("The file is larger than 2 MB", 413, "HR-RECRUITMENT-TEST-ITEM-IMPORT-TOO-LARGE");
    }
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length > IMPORT_LIMITS.maxBytes) throw fail("The file is larger than 2 MB", 413, "HR-RECRUITMENT-TEST-ITEM-IMPORT-TOO-LARGE");
    if (!buffer.length) throw fail("The file is empty", 400, "HR-RECRUITMENT-TEST-ITEM-IMPORT-FILE-INVALID");
    return buffer;
}

const headerKey = (h) => String(h ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Records (header first) -> { rows: [{ rowNumber, record }], ignoredColumns }. */
export function recordsToRows(records) {
    const [header = [], ...body] = records;
    const keys = header.map(headerKey);
    const missing = REQUIRED_COLUMNS.filter((c) => !keys.includes(c));
    if (missing.length) {
        throw fail(`The header row is missing ${missing.join(", ")}; use the template columns`, 400, "HR-RECRUITMENT-TEST-ITEM-IMPORT-HEADER-INVALID", { missing });
    }
    const ignoredColumns = [...new Set(keys.filter((k) => k && !IMPORT_COLUMNS.includes(k)))];
    const rows = [];
    body.forEach((cells, index) => {
        const record = {};
        keys.forEach((key, c) => {
            if (IMPORT_COLUMNS.includes(key) && record[key] === undefined) record[key] = String(cells[c] ?? "").trim();
        });
        if (Object.values(record).some((v) => v !== "")) rows.push({ rowNumber: index + 2, record });
    });
    if (rows.length > IMPORT_LIMITS.maxRows) {
        throw fail(`The file has ${rows.length} item rows; the limit is ${IMPORT_LIMITS.maxRows}`, 400, "HR-RECRUITMENT-TEST-ITEM-IMPORT-TOO-MANY-ROWS");
    }
    return { rows, ignoredColumns };
}

const blank = (v) => v === undefined || v === "";
const numberOrRaw = (v) => (blank(v) ? undefined : Number.isFinite(Number(v)) ? Number(v) : v);
const list = (v) => (blank(v) ? [] : String(v).split(/[;|]/).map((s) => s.trim()).filter(Boolean));

function booleanCell(v) {
    if (blank(v)) return undefined;
    const s = String(v).trim().toLowerCase();
    if (["yes", "y", "true", "1"].includes(s)) return true;
    if (["no", "n", "false", "0"].includes(s)) return false;
    return v; // normalizeItemInput reports it
}

/** One template row as normalizeItemInput input. */
export function rowToItemInput(rec) {
    const type = String(rec.type ?? "").trim().toUpperCase();
    const input = {
        itemCode: blank(rec.item_code) ? undefined : rec.item_code,
        type,
        stem: rec.stem,
        difficulty: rec.difficulty,
        competencyKey: rec.competency_key,
        skillId: numberOrRaw(rec.skill_id),
        jobFamily: blank(rec.job_family) ? undefined : rec.job_family,
        gradeLevelIds: list(rec.grade_level_ids).map(numberOrRaw),
        language: blank(rec.language) ? undefined : rec.language,
        timeEstimateSec: numberOrRaw(rec.time_estimate_sec),
        rationale: blank(rec.rationale) ? undefined : rec.rationale,
        discussionPrompt: booleanCell(rec.discussion_prompt),
        exposureCap: numberOrRaw(rec.exposure_cap),
        mediaId: numberOrRaw(rec.media_id),
    };
    if (type === "NUMERIC") {
        return { ...input, answerKey: { value: numberOrRaw(rec.numeric_value), tolerance: numberOrRaw(rec.numeric_tolerance) } };
    }
    if (type === "TRUE_FALSE") {
        const options = [
            { id: "true", text: blank(rec.option_a) ? "True" : rec.option_a },
            { id: "false", text: blank(rec.option_b) ? "False" : rec.option_b },
        ];
        return { ...input, options, answerKey: { optionIds: list(rec.correct).map((s) => s.toLowerCase()) } };
    }
    const options = LETTERS.filter((l) => !blank(rec[`option_${l}`])).map((l) => ({
        id: l,
        text: rec[`option_${l}`],
        feedback: blank(rec[`feedback_${l}`]) ? undefined : rec[`feedback_${l}`],
    }));
    return {
        ...input,
        options,
        answerKey: { optionIds: list(rec.correct).map((s) => s.toLowerCase()) },
        scoringRule: type === "MULTI" ? { multi: blank(rec.multi_scoring) ? undefined : rec.multi_scoring } : undefined,
    };
}

// ── Import ───────────────────────────────────────────────────────────────────

async function validateRows(tenantId, rows) {
    const errors = [];
    const valid = [];
    for (const { rowNumber, record } of rows) {
        const result = normalizeItemInput(rowToItemInput(record));
        if (result.ok) valid.push({ rowNumber, value: result.value });
        else errors.push({ row: rowNumber, errors: result.errors });
    }
    const linkErrors = await linkTaxonomy(prisma, tenantId, valid.map((v) => v.value));
    const linked = [];
    valid.forEach((entry, i) => {
        if (linkErrors[i].length) errors.push({ row: entry.rowNumber, errors: linkErrors[i] });
        else linked.push({ ...entry, itemCode: codeForNewItem(entry.value) });
    });
    const taken = await findTakenCodes(prisma, tenantId, linked.map((e) => e.itemCode));
    const firstRowFor = new Map();
    const entries = [];
    for (const entry of linked) {
        if (taken.has(entry.itemCode)) {
            errors.push({ row: entry.rowNumber, errors: [{ field: "itemCode", message: `An item with code ${entry.itemCode} already exists` }] });
        } else if (firstRowFor.has(entry.itemCode)) {
            errors.push({ row: entry.rowNumber, errors: [{ field: "itemCode", message: `Duplicate of row ${firstRowFor.get(entry.itemCode)}` }] });
        } else {
            firstRowFor.set(entry.itemCode, entry.rowNumber);
            entries.push(entry);
        }
    }
    errors.sort((a, b) => a.row - b.row);
    return { entries, errors };
}

/**
 * Import a CSV or XLSX item sheet. Valid rows become DRAFT items authored by
 * the caller (unless dryRun); invalid rows are reported and not written.
 */
export async function importTestItems({ tenantId, access, contentBase64, format, fileName, dryRun = false } = {}) {
    assertOnsiteTestEnabled();
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    assertAssessmentCapability(access, "author", "Only assessment authors can import test items");
    const authorId = Number(access?.employeeId);
    if (!Number.isInteger(authorId) || authorId <= 0) {
        throw fail("An employee identity is required to author test items", 403, "HR-RECRUITMENT-ASSESSMENT-ACTOR-REQUIRED");
    }
    const buffer = decodeFile(contentBase64);
    const kind = detectFormat(format, fileName, buffer);
    const records = kind === "xlsx" ? await parseXlsx(buffer) : parseCsv(buffer.toString("utf8"));
    const { rows, ignoredColumns } = recordsToRows(records);
    const { entries, errors } = await validateRows(tenantId, rows);

    const summary = { dryRun: dryRun === true, format: kind, totalRows: rows.length, validRows: entries.length, invalidRows: errors.length, ignoredColumns, errors };
    if (dryRun === true || !entries.length) return { ...summary, created: [] };
    try {
        const created = await tenantTransaction(
            prisma,
            async (tx) => await insertDraftItems(tx, tenantId, entries, { authorId }),
            { tenantId },
        );
        log.info({ tenantId, created: created.length, invalid: errors.length }, "test items imported");
        return {
            ...summary,
            created: created.map((row, i) => ({ row: entries[i].rowNumber, ...presentTestItemSummary(row) })),
        };
    } catch (err) {
        if (err?.code === "P2002") throw fail("Some items were created by someone else meanwhile; run the import again", 409, "HR-RECRUITMENT-TEST-ITEM-DUPLICATE");
        throw err;
    }
}

export default { importTestItems, parseCsv };
