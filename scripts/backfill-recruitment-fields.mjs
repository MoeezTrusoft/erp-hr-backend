// scripts/backfill-recruitment-fields.mjs — populate the newly-added recruitment
// columns with coherent mock data on the live tenant. Idempotent: only fills
// empty fields. Anchored to RBAC Company 1. Run in a node:24 pod with the NEW
// prisma client (knows the new columns). Offer.salary is C4-encrypted (decrypts
// on read); we copy it into compensation.baseSalary.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

const PRIORITIES = ["Low", "Medium", "Medium", "High", "Urgent"];
const IV_DECISIONS = ["NEXT_ROUND", "NEXT_ROUND", "HOLD", "REJECTED"];
const IVR_STATUS = ["invited", "accepted", "accepted", "completed"];
const OFFER_TYPES = ["Standard", "Standard", "Contract", "Internship", "Promotion"];
const EMP_TYPES = ["Full-time", "Full-time", "Part-time", "Contract"];
const BENEFITS = ["Health insurance", "Provident fund", "Gym membership", "Annual bonus", "Remote stipend", "Life insurance"];

const reqText = (title) => [
  `Proven experience relevant to ${title}.`,
  "Strong communication and collaboration.",
  "Bachelor's degree or equivalent.",
].join("\n");

async function main() {
  const log = (m) => console.log(`[recruit-backfill] ${m}`);

  // ---------- JobRequisition: priority + requirements ----------
  const reqs = await prisma.jobRequisition.findMany({ where: { tenantId: TENANT }, select: { id: true, title: true, priority: true, requirements: true } });
  let rc = 0;
  for (const r of reqs) {
    const data = {};
    if (r.priority == null || r.priority === "") data.priority = pick(PRIORITIES);
    if (r.requirements == null || r.requirements === "") data.requirements = reqText(r.title);
    if (Object.keys(data).length) { await prisma.jobRequisition.update({ where: { id: r.id }, data }); rc++; }
  }
  log(`requisitions: priority/requirements set on ${rc}/${reqs.length}`);

  // ---------- Interview.decision (completed) + InterviewInterviewer.status ----------
  const ivs = await prisma.interview.findMany({ where: { tenantId: TENANT }, select: { id: true, status: true, decision: true } });
  let ic = 0;
  for (const iv of ivs) {
    if ((iv.decision == null || iv.decision === "") && iv.status === "COMPLETED") {
      await prisma.interview.update({ where: { id: iv.id }, data: { decision: pick(IV_DECISIONS) } });
      ic++;
    }
  }
  log(`interviews: decision set on ${ic} completed`);
  // interviewer status — update rows that have none
  const ivrs = await prisma.interviewInterviewer.findMany({ where: { tenantId: TENANT, status: null }, select: { interviewId: true, employeeId: true } });
  let irc = 0;
  for (const x of ivrs) {
    await prisma.interviewInterviewer.update({
      where: { interviewId_employeeId: { interviewId: x.interviewId, employeeId: x.employeeId } },
      data: { status: pick(IVR_STATUS) },
    });
    irc++;
  }
  log(`interview interviewers: status set on ${irc}`);

  // ---------- Offer: type/employmentType/terms/compensation/approvals/viewedAt ----------
  const offers = await prisma.offer.findMany({
    where: { tenantId: TENANT },
    select: { id: true, salary: true, currency: true, status: true, sentAt: true, offerType: true, compensation: true },
  });
  let oc = 0;
  for (const o of offers) {
    if (o.offerType != null && o.compensation != null) continue; // already filled
    const base = Number(o.salary) || (90 + rnd(210)) * 1000; // salary decrypts to number
    const bonus = Math.round(base * (0.05 + Math.random() * 0.15));
    const allowances = Math.round(base * 0.1);
    const benefits = [...new Set(Array.from({ length: 2 + rnd(3) }, () => pick(BENEFITS)))];
    const sent = o.status !== "DRAFT";
    const data = {
      offerType: pick(OFFER_TYPES),
      employmentType: pick(EMP_TYPES),
      viewedAt: sent && o.sentAt ? new Date(new Date(o.sentAt).getTime() + (1 + rnd(48)) * 3600000) : null,
      terms: { probationMonths: pick([3, 3, 6]), noticePeriodDays: pick([30, 30, 60, 90]), additionalTerms: "Standard company terms apply.", specialClauses: null },
      compensation: { baseSalary: base, currency: o.currency || "PKR", bonus, allowances, benefits },
      approvals: {
        hiringManager: { by: "Hiring Manager", decision: "approved", at: o.sentAt || null, reason: null },
        hrHead: { by: "HR Head", decision: sent ? "approved" : "pending", at: o.sentAt || null, reason: null },
        finance: { by: "Finance", decision: sent ? "approved" : "pending", at: o.sentAt || null, reason: null },
      },
    };
    await prisma.offer.update({ where: { id: o.id }, data });
    oc++;
  }
  log(`offers: type/terms/compensation/approvals set on ${oc}/${offers.length}`);
  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("RECRUIT-BACKFILL ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
