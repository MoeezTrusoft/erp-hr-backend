// scripts/backfill-recruitment-extras.mjs — seed a real recruitment cost config
// (so cost-per-hire is "actual") + generate a real resume PDF per candidate and
// upload it to DAM (replacing the placeholder resumeMediaId). Tenant Company 1.
// Run in a node:24 pod (DAM reachable + new client with RecruitmentCostConfig).
import PDFDocument from "pdfkit";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { setCostConfig } from "../src/services/recruitmentCost.service.js";
import { uploadCandidateResume } from "../src/services/candidateResume.service.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";

function resumePdf({ name, email, phone, role, skills, source }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(22).font("Helvetica-Bold").text(name || "Candidate");
    doc.moveDown(0.2).fontSize(10).font("Helvetica").fillColor("#555")
      .text([email, phone, source ? `Source: ${source}` : null].filter(Boolean).join("  •  "));
    doc.fillColor("#000").moveDown(1);
    doc.fontSize(13).font("Helvetica-Bold").text("Applied Role");
    doc.fontSize(11).font("Helvetica").text(role || "—").moveDown(0.8);
    doc.fontSize(13).font("Helvetica-Bold").text("Skills");
    doc.fontSize(11).font("Helvetica").text((skills && skills.length ? skills.join(", ") : "—")).moveDown(0.8);
    doc.fontSize(13).font("Helvetica-Bold").text("Summary");
    doc.fontSize(11).font("Helvetica").text(
      `${name || "The candidate"} is a motivated professional applying for the ${role || "open"} position. This resume was generated for demo purposes.`);
    doc.end();
  });
}

async function main() {
  const log = (m) => console.log(`[extras] ${m}`);

  // 1) Real cost config
  const cfg = await setCostConfig(TENANT, { jobAds: 150000, agencyFees: 400000, tools: 80000, other: 60000, currency: "PKR" });
  log(`cost config set: jobAds=${cfg.jobAds} agencyFees=${cfg.agencyFees} tools=${cfg.tools} other=${cfg.other} ${cfg.currency}`);

  // 2) Real resume PDFs → DAM (replace placeholder ids)
  const cands = await prisma.candidate.findMany({
    where: { tenantId: TENANT },
    select: {
      id: true, firstName: true, lastName: true, email: true, phone: true, source: true, resumeMediaId: true,
      candidateSkills: { select: { name: true }, take: 6 },
      applications: { select: { jobRequisition: { select: { title: true } } }, orderBy: { appliedAt: "desc" }, take: 1 },
    },
  });
  let uploaded = 0, failed = 0;
  for (const c of cands) {
    // Only (re)upload placeholder ids (< 9000 means a real prior upload; skip those).
    if (c.resumeMediaId && c.resumeMediaId < 9000) continue;
    try {
      const pdf = await resumePdf({
        name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        email: c.email, phone: c.phone, source: c.source,
        role: c.applications?.[0]?.jobRequisition?.title || null,
        skills: (c.candidateSkills || []).map((s) => s.name),
      });
      const res = await uploadCandidateResume({
        candidateId: c.id, fileBase64: pdf.toString("base64"), fileName: `resume-${c.id}.pdf`, tenantId: TENANT,
      });
      uploaded++;
      if (uploaded <= 2) log(`candidate ${c.id} -> resumeMediaId ${res.resumeMediaId}`);
    } catch (e) {
      failed++;
      if (failed <= 3) log(`candidate ${c.id} upload FAILED: ${e.message}`);
    }
  }
  log(`resumes uploaded to DAM: ${uploaded}, failed: ${failed}`);
  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("EXTRAS ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
