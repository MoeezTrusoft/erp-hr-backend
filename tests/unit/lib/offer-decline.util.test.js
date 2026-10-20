// tests/unit/lib/offer-decline.util.test.js
//
// Recruitment Phase 3a — the offer decline vocabulary mirrors the migration's
// CHECK exactly, and normalizeDeclineInput keeps legacy callers (no reason)
// working while refusing an unexplained OTHER.
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";

import {
    DECLINE_NOTE_MAX_LENGTH,
    DECLINE_REASONS,
    DECLINE_REASON_CODES,
    declineReasonLabel,
    normalizeDeclineInput,
} from "../../../src/lib/offer-decline.util.js";

const MIGRATION = new URL(
    "../../../prisma/migrations/20261021003200_recruitment_interview_offer_orchestration/migration.sql",
    import.meta.url,
);

describe("decline vocabulary", () => {
    it("matches the migration CHECK exactly, in order, each with a label", () => {
        const sql = readFileSync(MIGRATION, "utf8");
        const check = sql.match(/offers_declineReasonCode_check"\s+CHECK \("declineReasonCode" IS NULL OR "declineReasonCode" IN\s*\(([^)]*)\)/);
        const fromSql = check[1].split(",").map((v) => v.trim().replace(/'/g, ""));
        expect(DECLINE_REASON_CODES).toEqual(fromSql);
        expect(DECLINE_REASONS.every((r) => typeof r.label === "string" && r.label.length > 0)).toBe(true);
        expect(sql).toContain(`char_length("declineNote") <= ${DECLINE_NOTE_MAX_LENGTH}`);
    });

    it("labels a known code and nothing else", () => {
        expect(declineReasonLabel("COMPENSATION")).toBe("Compensation");
        expect(declineReasonLabel("NOPE")).toBeNull();
        expect(declineReasonLabel(null)).toBeNull();
    });
});

describe("normalizeDeclineInput", () => {
    it("records nothing when a legacy caller sends no reason", () => {
        expect(normalizeDeclineInput({})).toEqual({ declineReasonCode: null, declineNote: null, talentPoolOptIn: null });
        expect(normalizeDeclineInput()).toEqual({ declineReasonCode: null, declineNote: null, talentPoolOptIn: null });
    });

    it("treats a note without a code as OTHER and trims it", () => {
        expect(normalizeDeclineInput({ declineNote: "  moving abroad  " })).toEqual({
            declineReasonCode: "OTHER",
            declineNote: "moving abroad",
            talentPoolOptIn: null,
        });
    });

    it("accepts a known code (case-insensitive) with or without a note", () => {
        expect(normalizeDeclineInput({ declineReasonCode: "compensation", talentPoolOptIn: true })).toEqual({
            declineReasonCode: "COMPENSATION",
            declineNote: null,
            talentPoolOptIn: true,
        });
    });

    it("refuses an unknown code, a non-string note, a long note and a non-boolean opt-in", () => {
        expect(() => normalizeDeclineInput({ declineReasonCode: "BORED" })).toThrow(expect.objectContaining({ status: 400, code: "HR-RECRUITMENT-OFFER-DECLINE-REASON-INVALID" }));
        expect(() => normalizeDeclineInput({ declineReasonCode: 3 })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-OFFER-DECLINE-REASON-INVALID" }));
        expect(() => normalizeDeclineInput({ declineNote: 5 })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-OFFER-DECLINE-NOTE-INVALID" }));
        expect(() => normalizeDeclineInput({ declineReasonCode: "TIMING", declineNote: "x".repeat(DECLINE_NOTE_MAX_LENGTH + 1) }))
            .toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-OFFER-DECLINE-NOTE-INVALID" }));
        expect(normalizeDeclineInput({ declineReasonCode: "TIMING", declineNote: "x".repeat(DECLINE_NOTE_MAX_LENGTH) }).declineNote).toHaveLength(DECLINE_NOTE_MAX_LENGTH);
        expect(() => normalizeDeclineInput({ talentPoolOptIn: "yes" })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-OFFER-DECLINE-OPT-IN-INVALID" }));
    });

    it("requires a note for OTHER", () => {
        expect(() => normalizeDeclineInput({ declineReasonCode: "OTHER" })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-OFFER-DECLINE-NOTE-REQUIRED" }));
        expect(() => normalizeDeclineInput({ declineReasonCode: "OTHER", declineNote: "   " })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-OFFER-DECLINE-NOTE-REQUIRED" }));
    });

    it("requires a code when the caller says so", () => {
        expect(() => normalizeDeclineInput({}, { requireCode: true })).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-OFFER-DECLINE-REASON-REQUIRED" }));
        expect(normalizeDeclineInput({ declineReasonCode: "NO_RESPONSE" }, { requireCode: true }).declineReasonCode).toBe("NO_RESPONSE");
    });
});
