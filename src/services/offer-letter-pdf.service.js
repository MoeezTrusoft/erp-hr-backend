// src/services/offer-letter-pdf.service.js
//
// Recruitment Phase 3a — draws a rendered offer letter as an A4 PDF and stores
// it in DAM.
//
//   * TEXT API ONLY. Every string (company name, subject, paragraphs, names)
//     goes through pdfkit's doc.text(), which lays out characters; nothing in a
//     letter is ever written as a PDF operator, so a value cannot inject one.
//   * DETERMINISTIC. The same inputs give the same bytes: the info dictionary
//     is fixed (CreationDate is the letter version's createdAt, no ModDate),
//     the standard Helvetica fonts are not embedded, and pdfkit derives the
//     file /ID from the info dictionary. Re-rendering an unchanged letter is
//     therefore byte-identical, which the content hash relies on.
//   * DAM. The file is uploaded through the same server-side DAM upload the
//     manual offer letter upload uses (uploadFileToDAM, type "document").
//   * NON-LATIN TEXT (Phase 7, B18b). A name, company or paragraph the
//     standard fonts cannot encode (Urdu, Arabic, Polish, ...) is drawn with
//     the bundled Unicode font, embedded as a subset (lib/pdf-unicode-text.util
//     .js); WinAnsi text takes the exact calls it took before, so an existing
//     Latin letter is still byte-identical. Scripts the bundled font lacks
//     (Chinese, Japanese, Korean) render as empty boxes rather than failing.
import PDFDocument from "pdfkit";

import { writeText } from "../lib/pdf-unicode-text.util.js";
import { uploadFileToDAM } from "./dam.media.service.js";

const MARGIN = 56;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

function drawSignatureBlock(doc, { companyName, candidateName }) {
    doc.moveDown(2);
    const width = (doc.page.width - MARGIN * 2 - 40) / 2;
    const left = MARGIN;
    const right = MARGIN + width + 40;
    // Keep the block on one page: a signature line orphaned from its label is
    // a letter nobody can sign cleanly.
    if (doc.y + 90 > doc.page.height - MARGIN) doc.addPage();
    const top = doc.y + 30;
    doc.moveTo(left, top).lineTo(left + width, top).stroke("#333333");
    doc.moveTo(right, top).lineTo(right + width, top).stroke("#333333");
    doc.fontSize(10);
    writeText(doc, `For ${companyName || "the company"}`, { font: "Helvetica-Bold", x: left, y: top + 6, options: { width } });
    writeText(doc, candidateName || "Candidate", { font: "Helvetica-Bold", x: right, y: top + 6, options: { width } });
    doc.font("Helvetica").fontSize(9).fillColor("#555555");
    doc.text("Authorised signatory, date", left, top + 22, { width });
    doc.text("Accepted by the candidate, date", right, top + 22, { width });
    doc.fillColor("#000000");
}

/**
 * Draw the letter. Resolves to a PDF Buffer.
 * @param {{ companyName?: string|null, subject?: string|null, paragraphs: string[],
 *           candidateName?: string|null, createdAt: Date|string }} letter
 */
export function generateOfferLetterPdf({ companyName = null, subject = null, paragraphs = [], candidateName = null, createdAt } = {}) {
    const created = createdAt ? new Date(createdAt) : null;
    if (!created || Number.isNaN(created.getTime())) {
        return Promise.reject(fail("A letter needs its version's createdAt", 500, "HR-RECRUITMENT-OFFER-LETTER-PDF-INVALID"));
    }
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: "A4",
            margin: MARGIN,
            info: {
                Title: subject || "Offer letter",
                Author: companyName || "",
                Creator: "erp-hr offer letters",
                Producer: "erp-hr",
                CreationDate: created,
            },
        });
        const chunks = [];
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const width = doc.page.width - MARGIN * 2;
        if (companyName) {
            doc.fontSize(18);
            writeText(doc, companyName, { font: "Helvetica-Bold", options: { align: "center", width } });
            doc.moveDown(0.3);
            const y = doc.y;
            doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).stroke("#999999");
            doc.moveDown(1);
        }
        if (subject) {
            doc.fontSize(12);
            writeText(doc, subject, { font: "Helvetica-Bold", options: { width } });
            doc.moveDown(0.8);
        }
        doc.font("Helvetica").fontSize(11);
        for (const paragraph of paragraphs) {
            writeText(doc, paragraph, { font: "Helvetica", options: { width, align: "left", lineGap: 2 } });
            doc.moveDown(0.8);
        }
        drawSignatureBlock(doc, { companyName, candidateName });
        doc.end();
    });
}

/**
 * Upload a letter PDF to DAM. Resolves to the DAM media id, or throws 502
 * HR-RECRUITMENT-OFFER-LETTER-UPLOAD-FAILED (uploadFileToDAM is fail-soft and
 * answers [] on any failure).
 */
export async function uploadOfferLetterPdf(buffer, fileName) {
    const uploaded = await uploadFileToDAM(
        { buffer, mimetype: "application/pdf", originalname: fileName },
        "document",
    );
    const mediaId = Number(uploaded?.[0]?.id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
        throw fail("The letter could not be stored in DAM; try again", 502, "HR-RECRUITMENT-OFFER-LETTER-UPLOAD-FAILED");
    }
    return mediaId;
}
