// src/services/evaluation-report-pdf.service.js
//
// Recruitment Phase 3b — draws the frozen candidate evaluation report and the
// panel's evaluation forms as an A4 PDF and stores it in DAM (plan 7.4.3:
// "On outcome, the form and evaluation report are rendered to PDF and stored
// in DAM against the application").
//
// Same approach as the offer letter PDF (offer-letter-pdf.service.js):
//   * TEXT API ONLY: every value goes through doc.text(), so nothing a
//     reviewer typed can become a PDF operator;
//   * DETERMINISTIC: the info dictionary is fixed (CreationDate is the
//     snapshot's frozenAt), standard fonts are not embedded;
//   * DAM: uploaded through uploadFileToDAM as a "document".
// It reads only the frozen snapshot, so the PDF says exactly what the record
// says. The prohibited-topic flag is not printed.
import PDFDocument from "pdfkit";

import { uploadFileToDAM } from "./dam.media.service.js";

const MARGIN = 50;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const fmt = (v, suffix = "") => (typeof v === "number" ? `${Math.round(v * 100) / 100}${suffix}` : "n/a");
const label = (s) => String(s ?? "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : "n/a");

function heading(doc, value) {
    doc.moveDown(0.6).font("Helvetica-Bold").fontSize(12).text(value);
    doc.font("Helvetica").fontSize(10).moveDown(0.2);
}

function line(doc, key, value) {
    doc.font("Helvetica-Bold").text(`${key}: `, { continued: true }).font("Helvetica").text(String(value ?? "n/a"));
}

function drawSummary(doc, report) {
    doc.font("Helvetica-Bold").fontSize(16).text("Candidate evaluation report", { align: "center" });
    doc.moveDown(0.4).font("Helvetica").fontSize(10);
    line(doc, "Candidate", report.candidate?.name ?? `Application #${report.applicationId}`);
    line(doc, "Requisition", report.requisition?.title ?? `#${report.requisitionId}`);
    line(doc, "Interview", `${label(report.interview?.interviewType)} on ${day(report.interview?.scheduledAt)}`);
    line(doc, "Outcome", report.outcome ?? report.interview?.decision ?? "n/a");
    if (report.form) line(doc, "Form", `${report.form.name} (version ${report.form.version})`);

    heading(doc, "Scores");
    const test = report.test;
    line(doc, "Test score", test ? (test.included ? fmt(test.scorePct, "%") : test.waived ? "waived" : "not included") : "no test");
    if (test?.band) line(doc, "Test band", test.band);
    line(doc, "Interview score", fmt(report.interviewScorePct, "%"));
    line(doc, "Composite score", fmt(report.compositeScore, "%"));
    line(doc, "Weights", `test ${report.weights?.testPct ?? 0}% / interview ${report.weights?.interviewPct ?? 100}%`);
    if (report.rank?.rank) line(doc, "Rank (advisory)", `${report.rank.rank} of ${report.rank.of}`);

    heading(doc, "Panel");
    const tally = Object.entries(report.recommendationTally ?? {}).map(([k, v]) => `${label(k)} ${v}`).join(", ");
    line(doc, "Recommendations", tally || "none");
    line(doc, "Submitted", `${report.panel?.submittedCount ?? 0} of ${report.panel?.size ?? 0}`);
    if (report.mustHaveFailed) {
        doc.fillColor("#a00000");
        for (const alert of report.mustHaveAlerts ?? []) line(doc, "Must-have not met", `${alert.reviewer ?? `#${alert.reviewerId}`}: ${(alert.criteria ?? []).join(", ")}`);
        doc.fillColor("#000000");
    }
    if (report.divergentCriteria?.length) {
        const names = report.divergentCriteria.map((k) => report.criteria?.[k]?.label ?? k).join(", ");
        line(doc, "Divergent criteria (debrief)", names);
    }
    if (test?.sections?.length) {
        heading(doc, "Test sections");
        for (const s of test.sections) line(doc, s.label ?? s.key, `${fmt(s.scorePct, "%")} (pass mark ${fmt(s.passMarkPct, "%")})`);
    }
}

function drawForm(doc, report, card) {
    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(13).text(`Evaluation form: ${card.reviewer ?? `#${card.reviewerId}`}`);
    doc.font("Helvetica").fontSize(10).moveDown(0.3);
    if (card.panelRole) line(doc, "Panel role", label(card.panelRole));
    line(doc, "Submitted", day(card.submittedAt));
    line(doc, "Weighted score", fmt(card.weightedScore, "%"));
    line(doc, "Recommendation", label(card.recommendation));
    if (card.decision) line(doc, "Decision", card.decision);
    line(doc, "Conflict of interest declared", card.coiDeclared ? "yes" : "no");
    if (card.amendmentCount) line(doc, "Amendments", card.amendmentCount);
    for (const section of report.sections ?? []) {
        const rated = section.criteria.filter((c) => card.criteria?.[c.key]);
        if (!rated.length) continue;
        heading(doc, section.label);
        for (const c of rated) {
            const entry = card.criteria[c.key];
            const value = entry.notAssessed ? "not assessed" : entry.rating ?? "n/a";
            line(doc, c.label, `${value}${c.mustHave ? " (must-have)" : ""}`);
            if (entry.note) doc.fillColor("#444444").text(entry.note, { indent: 12 }).fillColor("#000000");
        }
    }
    if (card.notes) {
        heading(doc, "Notes");
        doc.text(card.notes);
    }
}

/**
 * Draw the report. Resolves to a PDF Buffer.
 * @param {{ report: object, frozenAt: Date|string }} args
 */
export function generateEvaluationReportPdf({ report, frozenAt } = {}) {
    const created = frozenAt ? new Date(frozenAt) : null;
    if (!report || !created || Number.isNaN(created.getTime())) {
        return Promise.reject(fail("A frozen report is required", 500, "HR-RECRUITMENT-EVALUATION-PDF-INVALID"));
    }
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: "A4",
            margin: MARGIN,
            info: {
                Title: "Candidate evaluation report",
                Creator: "erp-hr evaluation forms",
                Producer: "erp-hr",
                CreationDate: created,
            },
        });
        const chunks = [];
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
        drawSummary(doc, report);
        for (const card of report.reviewers ?? []) drawForm(doc, report, card);
        doc.end();
    });
}

/**
 * Upload the PDF to DAM. Resolves to the media id, or throws 502
 * HR-RECRUITMENT-EVALUATION-UPLOAD-FAILED (uploadFileToDAM answers [] on failure).
 */
export async function uploadEvaluationReportPdf(buffer, fileName) {
    const uploaded = await uploadFileToDAM({ buffer, mimetype: "application/pdf", originalname: fileName }, "document");
    const mediaId = Number(uploaded?.[0]?.id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
        throw fail("The report could not be stored in DAM; try again", 502, "HR-RECRUITMENT-EVALUATION-UPLOAD-FAILED");
    }
    return mediaId;
}
