// Phase 3b — the item bank spreadsheet import: the RFC 4180 CSV parser
// (quoting, embedded commas, quotes and line breaks), XLSX through a generated
// workbook, per-row validation with row numbers, nothing partial on a row,
// duplicates, dry run and the size and row caps.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import ExcelJS from "exceljs";
import { createTestItemDb, createEventRecorder } from "./helpers/test-item.fake.js";

const { db, state } = createTestItemDb();
const { enqueueHrDomainEvent } = createEventRecorder();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/lib/aiPlaneClient.js", () => ({ runAiTask: jest.fn() }));
jest.unstable_mockModule("../../../src/services/candidate-match.service.js", () => ({
    loadAliasIndex: jest.fn(async () => new Map()),
    requisitionSkillRequirements: jest.fn(() => null),
}));

const { importTestItems, parseCsv, rowToItemInput } = await import("../../../src/services/test-item-import.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");
const { resolveAssessmentAccess } = await import("../../../src/lib/assessment-access.util.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const AUTHOR = resolveAssessmentAccess({ roles: ["ASSESSMENT_AUTHOR"], employeeId: 11 });
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const run = (args, access = AUTHOR) => mcpCtx.run({ user: { tenantId: TENANT } }, async () => await importTestItems({ tenantId: TENANT, access, ...args }));

const HEADER = "type,stem,option_a,option_b,option_c,correct,numeric_value,numeric_tolerance,difficulty,competency_key,rationale,discussion_prompt";
const CSV = [
    HEADER,
    "SINGLE,\"Which is a prime, odd number?\",4,7,9,b,,,EASY,numerical-reasoning,\"Seven is prime, \"\"odd\"\"\",yes",
    "MULTI,\"Pick the even numbers\r\n(all of them)\",2,3,4,a;c,,,MEDIUM,numerical-reasoning,,",
    "TRUE_FALSE,Water boils at 100 C at sea level,,,,true,,,EASY,science,,no",
    "NUMERIC,What is 12 x 12?,,,,,144,0,HARD,numerical-reasoning,,",
    "SINGLE,Bad key,1,2,,z,,,EASY,numerical-reasoning,,",
    "ESSAY,Unknown type,,,,,,,EASY,x,,",
    ",,,,,,,,,,,",
    "SINGLE,\"Which is a prime, odd number?\",4,7,9,b,,,EASY,numerical-reasoning,,",
].join("\r\n");

beforeEach(() => {
    for (const key of Object.keys(state)) state[key] = [];
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
});

describe("parseCsv (RFC 4180)", () => {
    it("handles quoted commas, doubled quotes, line breaks, CRLF and a BOM", () => {
        expect(parseCsv("﻿a,b\r\n\"x, y\",\"say \"\"hi\"\"\"\n\"two\nlines\",\r\n")).toEqual([
            ["a", "b"],
            ["x, y", "say \"hi\""],
            ["two\nlines", ""],
        ]);
        expect(parseCsv("a,b")).toEqual([["a", "b"]]);
        expect(parseCsv("\"\",x")).toEqual([["", "x"]]);
    });

    it.each([
        ["an unterminated quote", "a,\"b\nc"],
        ["a quote inside an unquoted field", "a,b\"c\""],
        ["text after a closing quote", "\"a\"b,c"],
    ])("refuses %s", (_label, text) => {
        expect(() => parseCsv(text)).toThrow(expect.objectContaining({ status: 400, code: "HR-RECRUITMENT-TEST-ITEM-IMPORT-FILE-INVALID" }));
    });
});

describe("rowToItemInput", () => {
    it("maps the template columns per type", () => {
        expect(rowToItemInput({ type: "single", stem: "Q", option_a: "1", option_b: "2", correct: "B", difficulty: "EASY", competency_key: "x", grade_level_ids: "3; 4" }))
            .toMatchObject({ type: "SINGLE", options: [{ id: "a", text: "1" }, { id: "b", text: "2" }], answerKey: { optionIds: ["b"] }, gradeLevelIds: [3, 4] });
        expect(rowToItemInput({ type: "SINGLE", job_family: "stores" }).jobFamily).toBe("stores"); // normalised by normalizeItemInput
        expect(rowToItemInput({ type: "NUMERIC", numeric_value: "2.5", numeric_tolerance: "" })).toMatchObject({ answerKey: { value: 2.5, tolerance: undefined } });
        expect(rowToItemInput({ type: "TRUE_FALSE", correct: "FALSE" }).options.map((o) => o.id)).toEqual(["true", "false"]);
    });
});

describe("importTestItems", () => {
    it("lands valid rows as DRAFTs and reports invalid rows with their row numbers", async () => {
        const res = await run({ contentBase64: b64(CSV), fileName: "items.csv" });
        expect(res).toMatchObject({ dryRun: false, format: "csv", totalRows: 7, validRows: 4, invalidRows: 3 });
        expect(res.errors.map((e) => e.row)).toEqual([6, 7, 9]);
        expect(res.errors[0].errors[0].message).toMatch(/do not exist/);
        expect(res.errors[2].errors[0].message).toMatch(/Duplicate of row 2/);
        expect(res.created.map((c) => c.row)).toEqual([2, 3, 4, 5]);
        expect(state.items).toHaveLength(4);
        expect(state.items.every((i) => i.status === "DRAFT" && i.authorId === 11 && i.tenantId === TENANT)).toBe(true);
        const [single, multi, tf, numeric] = state.items;
        expect(single).toMatchObject({ stem: "Which is a prime, odd number?", discussionPrompt: true, rationale: "Seven is prime, \"odd\"" });
        expect(multi.stem).toBe("Pick the even numbers\r\n(all of them)");
        expect(JSON.parse(multi.answerKey)).toEqual({ optionIds: ["a", "c"] });
        expect(tf.options.map((o) => o.id)).toEqual(["true", "false"]);
        expect(JSON.parse(numeric.answerKey)).toEqual({ value: 144, tolerance: 0 });
        expect(res.created[0]).not.toHaveProperty("answerKey");
    });

    it("dry run validates without writing, and a second import refuses codes already in the bank", async () => {
        const dry = await run({ contentBase64: b64(CSV), format: "csv", dryRun: true });
        expect(dry).toMatchObject({ dryRun: true, validRows: 4, created: [] });
        expect(state.items).toHaveLength(0);
        await run({ contentBase64: b64(CSV) });
        const again = await run({ contentBase64: b64(CSV) });
        expect(again.validRows).toBe(0);
        expect(again.errors.filter((e) => /already exists/.test(e.errors[0].message)).map((e) => e.row)).toEqual([2, 3, 4, 5, 9]);
        expect(state.items).toHaveLength(4);
    });

    it("reads an XLSX workbook (numbers, rich text) the same way", async () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Items");
        ws.addRow(["Type", "Stem", "Option A", "Option B", "Correct", "Difficulty", "Competency Key", "Time Estimate Sec", "Extra", "Job Family"]);
        ws.addRow(["SINGLE", { richText: [{ text: "Which " }, { text: "tool", font: { bold: true } }, { text: "?" }] }, "Hammer", "Saw", "a", "MEDIUM", "tools", 45, "ignored", " maintenance "]);
        ws.addRow(["SINGLE", "No key", "x", "y", "", "MEDIUM", "tools", 30, ""]);
        const buffer = Buffer.from(await wb.xlsx.writeBuffer());
        const res = await run({ contentBase64: buffer.toString("base64"), fileName: "bank.xlsx" });
        expect(res).toMatchObject({ format: "xlsx", totalRows: 2, validRows: 1, ignoredColumns: ["extra"] });
        expect(res.errors).toEqual([{ row: 3, errors: [expect.objectContaining({ field: "answerKey" })] }]);
        expect(state.items[0]).toMatchObject({ stem: "Which tool?", timeEstimateSec: 45, competencyKey: "tools", jobFamily: "MAINTENANCE" });
    });

    it("refuses a missing header column, a file over 2 MB and more than 500 rows", async () => {
        await expect(run({ contentBase64: b64("type,stem\nSINGLE,x") })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-TEST-ITEM-IMPORT-HEADER-INVALID" });
        await expect(run({ contentBase64: b64(`${HEADER}\n${"x".repeat(2 * 1024 * 1024)}`) })).rejects.toMatchObject({ status: 413, code: "HR-RECRUITMENT-TEST-ITEM-IMPORT-TOO-LARGE" });
        const rows = Array.from({ length: 501 }, (_, i) => `SINGLE,Q${i},1,2,,a,,,EASY,x,,`);
        await expect(run({ contentBase64: b64([HEADER, ...rows].join("\n")) })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-TEST-ITEM-IMPORT-TOO-MANY-ROWS" });
        await expect(run({ contentBase64: "%%%" })).rejects.toMatchObject({ status: 400 });
        await expect(run({ contentBase64: b64("not a zip"), format: "xlsx" })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-TEST-ITEM-IMPORT-FILE-INVALID" });
        expect(state.items).toHaveLength(0);
    });

    it("needs the author capability and the flag", async () => {
        await expect(run({ contentBase64: b64(CSV) }, resolveAssessmentAccess({ roles: ["RECEPTION"], employeeId: 4 }))).rejects.toMatchObject({ status: 403 });
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        await expect(run({ contentBase64: b64(CSV) })).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-ONSITE-TEST-DISABLED" });
    });
});
