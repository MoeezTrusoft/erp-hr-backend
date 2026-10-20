// Recruitment Phase 3a — the offer letter merge-field renderer: a closed field
// vocabulary checked at save time, a 50 KB cap, one-pass literal substitution
// (no HTML, no re-expansion), missing values reported, dates in the tenant zone.
import { describe, it, expect } from "@jest/globals";

import {
    MERGE_FIELDS,
    MAX_TEMPLATE_BODY_BYTES,
    buildMergeValues,
    extractMergeFields,
    formatLetterDate,
    normalizeTemplateKey,
    renderOfferLetter,
    validateOfferLetterTemplate,
} from "../../../src/lib/offer-letter-template.util.js";

const CONTEXT = {
    candidate: { firstName: "Zoe", lastName: "Khan" },
    job: { title: "Sales Lead", department: "Sales" },
    offer: {
        startDate: new Date("2026-11-01T00:00:00Z"),
        expiryDate: "2026-10-27T20:00:00Z",
        salary: 250000,
        currency: "PKR",
        employmentType: "Full-time",
        probationMonths: 3,
        noticePeriodDays: 30,
        benefits: ["Medical", "Fuel allowance"],
    },
    company: { name: "TruSoft" },
};
const NOW = new Date("2026-10-20T21:30:00Z"); // already 21 Oct in Karachi (UTC+5)

describe("validateOfferLetterTemplate", () => {
    it("accepts every documented merge field", () => {
        const body = MERGE_FIELDS.map((f) => `{{${f}}}`).join("\n\n");
        expect(validateOfferLetterTemplate({ name: "All", subject: "Offer: {{ job.title }}", body }).body).toBe(body);
    });

    it("refuses unknown fields and lists the allowed ones", () => {
        let error;
        try {
            validateOfferLetterTemplate({ name: "Bad", body: "Dear {{candidate.email}}, your {{offer.bonus}}" });
        } catch (err) {
            error = err;
        }
        expect(error.status).toBe(422);
        expect(error.code).toBe("HR-RECRUITMENT-OFFER-LETTER-TEMPLATE-INVALID");
        expect(error.details.unknownFields).toEqual(["candidate.email", "offer.bonus"]);
        expect(error.details.allowedFields).toEqual([...MERGE_FIELDS]);
        expect(error.message).toContain("{{candidate.firstName}}");
    });

    it("refuses unknown fields in the subject too", () => {
        expect(() => validateOfferLetterTemplate({ name: "x", subject: "{{secret}}", body: "Hi" })).toThrow(/unknown merge fields/);
    });

    it("refuses an unbalanced tag", () => {
        expect(() => validateOfferLetterTemplate({ name: "x", body: "Dear {{candidate.firstName" })).toThrow(/malformed/);
        expect(() => validateOfferLetterTemplate({ name: "x", body: "Dear candidate.firstName}}" })).toThrow(/malformed/);
        // A single brace is ordinary text.
        expect(validateOfferLetterTemplate({ name: "x", body: "Dear {{{candidate.firstName}}}" }).body).toContain("{{{");
    });

    it("caps the body at 50 KB (bytes, not characters)", () => {
        expect(validateOfferLetterTemplate({ name: "x", body: "a".repeat(MAX_TEMPLATE_BODY_BYTES) }).body).toHaveLength(MAX_TEMPLATE_BODY_BYTES);
        expect(() => validateOfferLetterTemplate({ name: "x", body: "a".repeat(MAX_TEMPLATE_BODY_BYTES + 1) })).toThrow(/50 KB/);
        // 2-byte characters: 26 000 of them are 52 000 bytes.
        expect(() => validateOfferLetterTemplate({ name: "x", body: "é".repeat(26000) })).toThrow(/50 KB/);
    });

    it("requires a name and a body", () => {
        expect(() => validateOfferLetterTemplate({ name: " ", body: "x" })).toThrow(/name is required/);
        expect(() => validateOfferLetterTemplate({ name: "x", body: "  \n " })).toThrow(/body is required/);
    });
});

describe("normalizeTemplateKey / extractMergeFields", () => {
    it("maps offer types to keys", () => {
        expect(normalizeTemplateKey("Standard")).toBe("STANDARD");
        expect(normalizeTemplateKey("fixed term contract")).toBe("FIXED_TERM_CONTRACT");
        expect(normalizeTemplateKey("")).toBeNull();
        expect(normalizeTemplateKey("9lives")).toBeNull();
    });

    it("lists each field once in order", () => {
        expect(extractMergeFields("{{a}} {{ b }} {{a}}")).toEqual(["a", "b"]);
    });
});

describe("renderOfferLetter", () => {
    const values = buildMergeValues(CONTEXT, { timeZone: "Asia/Karachi", now: NOW });

    it("fills every field", () => {
        expect(values).toEqual({
            "candidate.firstName": "Zoe",
            "candidate.lastName": "Khan",
            "job.title": "Sales Lead",
            "job.department": "Sales",
            "offer.startDate": "1 November 2026",
            "offer.expiryDate": "28 October 2026", // 20:00 UTC is 01:00 next day in Karachi
            "offer.salary": "250,000",
            "offer.currency": "PKR",
            "offer.employmentType": "Full-time",
            "offer.probationMonths": "3",
            "offer.noticePeriodDays": "30",
            "offer.benefits": "Medical, Fuel allowance",
            "company.name": "TruSoft",
            today: "21 October 2026",
        });
        const out = renderOfferLetter({ subject: "Offer: {{job.title}}", body: MERGE_FIELDS.map((f) => `${f}={{${f}}}`).join("\n\n") }, values);
        expect(out.subject).toBe("Offer: Sales Lead");
        expect(out.paragraphs).toHaveLength(MERGE_FIELDS.length);
        expect(out.paragraphs[6]).toBe("offer.salary=250,000");
        expect(out.warnings).toEqual([]);
    });

    it("formats dates in the tenant's zone", () => {
        expect(formatLetterDate("2026-10-20T21:30:00Z", "UTC")).toBe("20 October 2026");
        expect(formatLetterDate("2026-10-20T21:30:00Z", "Asia/Karachi")).toBe("21 October 2026");
        expect(formatLetterDate("not a date")).toBeNull();
    });

    it("renders missing values as empty strings and reports each once", () => {
        const sparse = buildMergeValues({ candidate: { firstName: "Zoe" }, offer: { probationMonths: 0 } }, { now: NOW });
        const out = renderOfferLetter({ body: "Dear {{candidate.firstName}} {{candidate.lastName}},\n\nIn {{job.department}} / {{job.department}}. Probation {{offer.probationMonths}}." }, sparse);
        expect(out.paragraphs).toEqual(["Dear Zoe ,", "In  / . Probation 0."]);
        expect(out.warnings).toEqual([
            { field: "candidate.lastName", reason: "MISSING_VALUE" },
            { field: "job.department", reason: "MISSING_VALUE" },
        ]);
    });

    it("prints values literally: no HTML, no re-expansion, no new paragraphs", () => {
        const hostile = buildMergeValues(
            { candidate: { firstName: "<script>alert(1)</script>", lastName: "{{offer.salary}}" }, company: { name: "A\n\nB $& $1" }, offer: { salary: 1 } },
            { now: NOW },
        );
        const out = renderOfferLetter({ body: "Dear {{candidate.firstName}} {{candidate.lastName}} of {{company.name}}" }, hostile);
        expect(out.paragraphs).toEqual(["Dear <script>alert(1)</script> {{offer.salary}} of A B $& $1"]);
    });

    it("splits paragraphs on blank lines and keeps single line breaks", () => {
        const out = renderOfferLetter({ body: "One\r\nline two\r\n\r\n\r\nThree  \n \nFour" }, values);
        expect(out.paragraphs).toEqual(["One\nline two", "Three", "Four"]);
        expect(out.text).toBe("One\nline two\n\nThree\n\nFour");
    });
});
