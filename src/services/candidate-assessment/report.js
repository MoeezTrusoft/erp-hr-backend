import PDFDocument from "pdfkit";
import { createReportText } from "./pdfText.js";
import { run, interview, fail } from "./base.js";
import { getCtx } from "../../mcp/context.js";
import prisma from "../../lib/prisma.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { uploadFileToDAM } from "../dam.media.service.js";

export function renderEvaluationPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      pdfVersion: "1.5",
      tagged: true,
      bufferPages: true,
      lang: "en",
      info: { Title: "Candidate evaluation report", Author: "TruSoft HR" },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const line = createReportText(doc);
    const field = (label, value) =>
      line(
        label +
          (/\p{Script_Extensions=Arabic}/u.test(String(value)) ? "\n" : " ") +
          value,
      );
    line("CANDIDATE EVALUATION", 20);
    line(report.candidateName, 16);
    line(report.requisitionTitle, 13);
    line(
      "Application " +
        report.applicationId +
        " | Interview " +
        report.interviewId +
        " | Snapshot " +
        report.id,
    );
    line("Frozen at " + new Date(report.frozenAt).toISOString());
    line("Assessment status: " + report.snapshot.assessmentStatus);
    line(
      "Test: " +
        (report.testScorePct ?? "Excluded") +
        " | Interview: " +
        (report.interviewScorePct ?? "Not assessed") +
        " | Composite: " +
        (report.compositeScore ?? "Not assessed"),
    );
    line(
      "Weights: test " +
        report.weights.test +
        "%, interview " +
        report.weights.interview +
        "%. Advisory rank: " +
        (report.rankAtSnapshot ?? "Unavailable"),
    );
    line(
      "Must-have criteria: " +
        (report.snapshot.mustHaveFailed
          ? "NOT MET — review evidence"
          : "No recorded failure"),
    );
    line(
      "Recommendations: " +
        Object.entries(report.snapshot.recommendationTally ?? {})
          .map(([k, v]) => k + ": " + v)
          .join(", "),
    );
    if (report.snapshot.divergence?.length)
      line(
        "Debrief required for divergent criteria: " +
          report.snapshot.divergence.join(", "),
      );
    for (const section of report.snapshot.test?.sectionScores ?? []) {
      if (doc.y > 680) doc.addPage();
      line(
        "Test section " +
          section.key +
          ": " +
          Math.round(section.scorePct * 10) / 10 +
          "% | Required: " +
          (section.passMarkPct ?? "Not recorded") +
          (section.mustPass ? " (must pass)" : ""),
      );
      const x = doc.page.margins.left,
        y = doc.y,
        width = 300;
      doc.markContent("Artifact", { type: "Layout" });
      doc.save().rect(x, y, width, 8).fill("#e2e8e9");
      doc
        .rect(
          x,
          y,
          (width * Math.max(0, Math.min(100, section.scorePct))) / 100,
          8,
        )
        .fill("#176b5b");
      if (section.passMarkPct != null)
        doc
          .moveTo(x + (width * section.passMarkPct) / 100, y - 2)
          .lineTo(x + (width * section.passMarkPct) / 100, y + 10)
          .lineWidth(1)
          .stroke("#1d343c");
      doc.restore();
      doc.endMarkedContent();
      doc.y = y + 20;
    }
    const test = report.snapshot.test;
    if (test?.timeTakenSec != null)
      line(
        "Assessment time (pauses excluded): " + test.timeTakenSec + " seconds",
      );
    if (test?.cohortSize != null)
      line(
        "Assessment percentile: " +
          (test.percentile ?? "Insufficient comparable results") +
          " | Cohort: " +
          test.cohortSize,
      );
    if (test?.reused)
      line("Reused assessment from interview #" + test.sourceInterviewId);
    for (const probe of test?.probes ?? []) {
      line("Probe competency: " + probe.competencyKey, 13);
      if (!probe.questions.length) line(probe.suggestion);
      for (const question of probe.questions) {
        line(question.prompt);
        for (const follow of question.followUps) field("Follow-up:", follow);
        field("Evidence guide:", question.goodAnswerGuide);
      }
    }
    for (const prompt of test?.discussionPrompts ?? [])
      field("Test discussion:", prompt.stem);
    for (const signal of test?.integrityEvents ?? [])
      line("Integrity: " + signal.occurredAt + " | " + signal.type);
    for (const card of report.snapshot.cards ?? []) {
      // Keep the panel heading and its first evidence block on the same page.
      if (doc.y > 590) doc.addPage();
      line(
        "Panelist #" +
          card.reviewerId +
          " - " +
          (card.recommendation ?? "No recommendation"),
        14,
      );
      line(
        "Submitted: " +
          card.submittedAt +
          " | Template version: " +
          (card.templateVersion ?? "Legacy"),
      );
      line(
        "Weighted score: " +
          (card.weightedScore ?? card.overallScore ?? "Not assessed"),
      );
      for (const answer of card.criterionScores ?? []) {
        line(answer.key + ": " + (answer.rating ?? "Not assessed"), 11, {
          keepWithNext: true,
        });
        field("Evidence:", answer.evidence || "Not provided");
      }
      if (card.notes) field("Notes:", card.notes);
      if (card.reviewFlags?.length)
        line("HR review flags: " + card.reviewFlags.join(", "));
      if (card.amendmentLog?.length)
        line("Amendment count at freeze: " + card.amendmentLog.length);
    }
    line(
      "Scores and rankings support a human decision. This frozen report is unchanged by later template revisions.",
      10,
    );
    const pages = doc.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index++) {
      doc.switchToPage(index);
      doc.markContent("Artifact", { type: "Pagination", attached: ["Bottom"] });
      doc
        .font("ReportLatin")
        .fontSize(8)
        .fillColor("#475569")
        .text(
          "Application " +
            report.applicationId +
            " | Interview " +
            report.interviewId +
            " | Page " +
            (index + 1) +
            " of " +
            pages.count,
          doc.page.margins.left,
          doc.page.height - 30,
          { lineBreak: false },
        );
      doc.endMarkedContent();
    }
    doc.end();
  });
}

export async function evaluationExport(input) {
  const report = await run(
    "hr.recruitment.export",
    async (tx, env) => {
      const i = await interview(tx, env, input.interviewId);
      if (!["ORG", "MANAGED"].includes(env.scope.level))
        fail("Only the hiring team may export evaluation reports", 403);
      if (
        i.interviewers.some((p) => p.employeeId === env.who.id) &&
        !(await tx.interviewScorecard.findFirst({
          where: {
            tenantId: env.tenantId,
            interviewId: i.id,
            reviewerId: env.who.id,
            submittedAt: { not: null },
          },
        }))
      )
        fail("Submit your own feedback before exporting the report", 403);
      const summary = await tx.candidateEvaluationSummary.findFirst({
        where: { tenantId: env.tenantId, interviewId: i.id },
      });
      if (!summary)
        fail("Record the interview outcome before exporting its frozen report");
      return {
        ...summary,
        candidateName: [
          i.application.candidate.firstName,
          i.application.candidate.lastName,
        ]
          .filter(Boolean)
          .join(" "),
        requisitionTitle: i.application.jobRequisition.title,
      };
    },
    "evaluationForms",
  );
  if (report.pdfMediaId)
    return { summaryId: report.id, mediaId: report.pdfMediaId };
  const buffer = await renderEvaluationPdf(report),
    ctx = getCtx();
  const assets = await uploadFileToDAM(
    {
      buffer,
      mimetype: "application/pdf",
      originalname: "evaluation-" + report.id + ".pdf",
    },
    "recruitment-evaluation",
    { externalId: "hr-evaluation-" + ctx.user.tenantId + "-" + report.id },
  );
  const mediaId = assets[0]?.id ?? assets[0]?.mediaId;
  if (!mediaId)
    fail("Evaluation PDF could not be stored; retry this export", 503);
  await tenantTransaction(
    prisma,
    async (tx) => {
      const row = await tx.candidateEvaluationSummary.findFirst({
        where: { tenantId: ctx.user.tenantId, id: report.id },
      });
      if (!row) fail("Evaluation no longer exists", 404);
      await tx.candidateEvaluationSummary.update({
        where: { id: row.id },
        data: { pdfMediaId: String(mediaId) },
      });
    },
    { tenantId: ctx.user.tenantId },
  );
  return { summaryId: report.id, mediaId: String(mediaId) };
}
