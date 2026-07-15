// scripts/backfill-interviews.mjs — create a coherent recruitment→interview
// dataset (requisitions → candidates → applications → interviews + interviewers
// + scorecards) on the live tenant. Idempotent: no-op if interviews already
// exist. Anchored to RBAC Company 1 "Default Company".
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const sample = (a, k) => { const c = [...a]; const o = []; while (o.length < k && c.length) o.push(c.splice(rnd(c.length), 1)[0]); return o; };
const daysAgo = (d) => new Date(Date.now() - d * 86400000);
const round2 = (n) => Math.round(n * 100) / 100;
const atClock = (d, h, m) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, 0));

const REQ_TITLES = [
  "Senior Backend Engineer", "Frontend Engineer (React)", "Product Designer",
  "DevOps Engineer", "Account Executive", "HR Business Partner",
  "Data Analyst", "QA Automation Engineer",
];
const FIRST = ["Ahmed","Ali","Hassan","Usman","Bilal","Hamza","Zain","Omar","Ayesha","Fatima","Sana","Hira","Maria","Zainab","Amna","Iqra","Mahnoor","Nimra","Sadia","Rabia","Areeba","Komal","Bushra","Sania"];
const LAST = ["Khan","Ahmed","Malik","Sheikh","Butt","Chaudhry","Raza","Hussain","Iqbal","Farooq","Siddiqui","Qureshi","Abbasi","Zafar","Nawaz","Mirza"];
const SOURCES = ["LinkedIn","Referral","Company Website","Indeed","Rozee.pk","Recruiter"];
const IV_TYPES = ["PHONE_SCREEN","TECHNICAL","BEHAVIORAL","PANEL","FINAL"];
const LOCATIONS = ["Zoom","Google Meet","Karachi HQ — Room 3","Lahore Office — Boardroom","MS Teams"];
const RECS = ["Strong Hire","Hire","Lean Hire","No Hire"];
const CRITERIA = ["technical","communication","problem_solving","culture_fit","experience"];

async function main() {
  const log = (m) => console.log(`[iv-backfill] ${m}`);

  const existing = await prisma.interview.count({ where: { tenantId: TENANT } });
  if (existing > 0) { log(`interviews already present (${existing}) — skipping`); return; }

  const emps = await prisma.employee.findMany({ select: { id: true } });
  const empIds = emps.map((e) => e.id);
  if (empIds.length === 0) { log("no employees — aborting"); return; }
  log(`${empIds.length} employees available as interviewers/requesters`);

  // ---------- Requisitions ----------
  const reqs = [];
  for (const title of REQ_TITLES) {
    const r = await prisma.jobRequisition.create({ data: {
      title, description: `We are hiring a ${title}.`,
      requestedById: pick(empIds), approvedById: pick(empIds),
      openings: 1 + rnd(3), status: "POSTED", tenantId: TENANT,
    } });
    reqs.push(r);
  }
  log(`${reqs.length} job requisitions created`);

  // ---------- Candidates ----------
  const cands = [];
  for (let i = 0; i < 24; i++) {
    const fn = pick(FIRST), ln = pick(LAST);
    const c = await prisma.candidate.create({ data: {
      firstName: fn, lastName: ln,
      email: `${fn}.${ln}.${i}${rnd(9999)}@example.com`.toLowerCase(),
      phone: `+9230${rnd(9)}${String(rnd(9999999)).padStart(7, "0")}`,
      source: pick(SOURCES), status: "active", tenantId: TENANT,
    } });
    cands.push(c);
  }
  log(`${cands.length} candidates created`);

  // ---------- Applications ----------
  const STAGES = ["screening", "interview", "interview", "offer"];
  const apps = [];
  for (const c of cands) {
    const req = pick(reqs);
    try {
      const a = await prisma.application.create({ data: {
        candidateId: c.id, jobRequisitionId: req.id,
        stage: pick(STAGES), status: "open", tenantId: TENANT,
      } });
      apps.push(a);
    } catch (e) { /* unique [candidateId, jobRequisitionId] collision — skip */ }
  }
  log(`${apps.length} applications created`);

  // ---------- Interviews + interviewers + scorecards ----------
  let ivCount = 0, panelCount = 0, scCount = 0;
  for (const a of apps) {
    if (a.stage === "screening") continue; // not far enough to have interviews
    const rounds = a.stage === "offer" ? 3 : 1 + rnd(2);
    for (let r = 0; r < rounds; r++) {
      const type = IV_TYPES[Math.min(r, IV_TYPES.length - 1)];
      const past = Math.random() < 0.6;
      const day = past ? daysAgo(3 + rnd(25)) : new Date(Date.now() + (1 + rnd(14)) * 86400000);
      const scheduledAt = atClock(day, 10 + rnd(6), pick([0, 30]));
      const status = past ? (Math.random() < 0.85 ? "COMPLETED" : Math.random() < 0.5 ? "NO_SHOW" : "CANCELLED") : "SCHEDULED";
      const iv = await prisma.interview.create({ data: {
        applicationId: a.id, interviewType: type, scheduledAt,
        durationMinutes: pick([30, 45, 60, 60, 90]), location: pick(LOCATIONS),
        status, notes: status === "COMPLETED" ? "Interview completed; feedback recorded." : status === "SCHEDULED" ? "Calendar invite sent." : null,
        tenantId: TENANT,
      } });
      ivCount++;

      // Interviewers (1–3 distinct employees)
      const panel = sample(empIds, 1 + rnd(3));
      for (const eId of panel) {
        await prisma.interviewInterviewer.create({ data: { interviewId: iv.id, employeeId: eId, tenantId: TENANT } });
        panelCount++;
      }

      // Scorecards for completed interviews (one per interviewer)
      if (status === "COMPLETED") {
        for (const reviewerId of panel) {
          const scores = {}; let sum = 0;
          for (const k of CRITERIA) { const v = 2 + rnd(4); scores[k] = v; sum += v; }
          try {
            await prisma.interviewScorecard.create({ data: {
              interviewId: iv.id, reviewerId,
              scores, overallScore: round2(sum / CRITERIA.length),
              recommendation: pick(RECS),
              notes: "Structured feedback captured against the scorecard rubric.",
              submittedAt: new Date(scheduledAt.getTime() + 3600000), tenantId: TENANT,
            } });
            scCount++;
          } catch (e) { /* unique [interviewId, reviewerId] */ }
        }
      }
    }
  }
  log(`${ivCount} interviews, ${panelCount} interviewer links, ${scCount} scorecards created`);
  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("IV-BACKFILL ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
