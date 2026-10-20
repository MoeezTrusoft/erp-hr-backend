// Recruitment Phase 3a — the offer letter PDF: a real pdfkit document, byte-
// identical for identical inputs (fixed CreationDate), stored through the DAM
// upload the manual offer-letter upload uses.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const uploadFileToDAM = jest.fn();
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ uploadFileToDAM }));

const { generateOfferLetterPdf, uploadOfferLetterPdf } = await import("../../../src/services/offer-letter-pdf.service.js");

const LETTER = {
    companyName: "TruSoft",
    subject: "Offer of employment: Sales Lead",
    paragraphs: ["21 October 2026", "Dear Zoe Khan,", "We are pleased to offer you <b>the role</b> (BT /F1 12 Tf ET)."],
    candidateName: "Zoe Khan",
    createdAt: new Date("2026-10-21T04:00:00Z"),
};

beforeEach(() => jest.clearAllMocks());

describe("generateOfferLetterPdf", () => {
    it("produces a PDF", async () => {
        const pdf = await generateOfferLetterPdf(LETTER);
        expect(Buffer.isBuffer(pdf)).toBe(true);
        expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        expect(pdf.subarray(-6).toString("latin1")).toContain("%%EOF");
    });

    it("is deterministic for the same inputs", async () => {
        const a = await generateOfferLetterPdf(LETTER);
        await new Promise((r) => setTimeout(r, 1100)); // a second later: no clock in the bytes
        const b = await generateOfferLetterPdf(LETTER);
        expect(a.equals(b)).toBe(true);
        const c = await generateOfferLetterPdf({ ...LETTER, createdAt: new Date("2026-10-22T04:00:00Z") });
        expect(a.equals(c)).toBe(false);
    });

    it("needs the version's createdAt", async () => {
        await expect(generateOfferLetterPdf({ ...LETTER, createdAt: null })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-LETTER-PDF-INVALID" });
    });
});

describe("uploadOfferLetterPdf", () => {
    it("stores the PDF as a DAM document and returns its media id", async () => {
        uploadFileToDAM.mockResolvedValue([{ id: 812 }]);
        const buffer = Buffer.from("%PDF-1.3");
        await expect(uploadOfferLetterPdf(buffer, "offer-1.pdf")).resolves.toBe(812);
        expect(uploadFileToDAM).toHaveBeenCalledWith({ buffer, mimetype: "application/pdf", originalname: "offer-1.pdf" }, "document");
    });

    it("throws 502 when DAM stores nothing", async () => {
        uploadFileToDAM.mockResolvedValue([]);
        await expect(uploadOfferLetterPdf(Buffer.from("x"), "a.pdf")).rejects.toMatchObject({ status: 502, code: "HR-RECRUITMENT-OFFER-LETTER-UPLOAD-FAILED" });
    });
});
