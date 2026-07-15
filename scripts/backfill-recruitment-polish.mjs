// scripts/backfill-recruitment-polish.mjs — cosmetic data polish so the
// recruitment analytics / interview ratings / talent-pool skills render fully.
// Idempotent-ish. Tenant Company 1. Run in a node:24 pod.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const r5 = () => 2 + rnd(4); // 2..5

const SKILLS = ["JavaScript", "React", "Node.js", "SQL", "Python", "Communication", "Leadership", "Problem Solving", "Figma", "AWS", "Docker", "TypeScript"];

async function main() {
  const log = (m) => console.log(`[polish] ${m}`);

  // 1) Mark a few applications (that have an ACCEPTED offer) as hired → analytics totalHires/timeToHire.
  const acceptedOffers = await prisma.offer.findMany({ where: { tenantId: TENANT, status: "ACCEPTED" }, select: { applicationId: true } });
  let hired = 0;
  for (const o of acceptedOffers) {
    await prisma.application.update({ where: { id: o.applicationId }, data: { stage: "hired", status: "closed" } });
    hired++;
  }
  log(`applications marked hired: ${hired}`);

  // 2) Re-key InterviewScorecard.scores to the camelCase keys the interview tool reads.
  const cards = await prisma.interviewScorecard.findMany({ where: { tenantId: TENANT }, select: { id: true, scores: true } });
  let rk = 0;
  for (const c of cards) {
    const s = (c.scores && typeof c.scores === "object") ? c.scores : {};
    const scores = {
      technicalSkills: Number(s.technicalSkills ?? s.technical ?? r5()),
      problemSolving: Number(s.problemSolving ?? s.problem_solving ?? r5()),
      communication: Number(s.communication ?? r5()),
      cultureFit: Number(s.cultureFit ?? s.culture_fit ?? r5()),
    };
    const overall = Math.round(((scores.technicalSkills + scores.problemSolving + scores.communication + scores.cultureFit) / 4) * 100) / 100;
    await prisma.interviewScorecard.update({ where: { id: c.id }, data: { scores, overallScore: overall } });
    rk++;
  }
  log(`scorecards re-keyed: ${rk}`);

  // 3) Add candidate skills → talent pool skills.
  const cands = await prisma.candidate.findMany({ where: { tenantId: TENANT }, select: { id: true } });
  let cs = 0;
  for (const c of cands) {
    const existing = await prisma.candidateSkill.count({ where: { candidateId: c.id } });
    if (existing > 0) continue;
    const mine = [...new Set(Array.from({ length: 3 + rnd(3) }, () => pick(SKILLS)))];
    for (const name of mine) {
      await prisma.candidateSkill.create({ data: {
        candidateId: c.id, name, category: "skill", score: 50 + rnd(50), level: pick(["Beginner", "Intermediate", "Advanced", "Expert"]), source: "seed", tenantId: TENANT,
      } });
      cs++;
    }
  }
  log(`candidate skills created: ${cs}`);
  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("POLISH ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
