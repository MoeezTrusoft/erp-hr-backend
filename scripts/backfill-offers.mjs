// scripts/backfill-offers.mjs — create job Offers for existing applications on
// the live tenant. Idempotent: no-op if offers already exist. Depends on the
// recruitment chain from backfill-interviews.mjs. Anchored to RBAC Company 1.
// Offer.salary is C4-encrypted at rest (write plaintext string; the prisma C4
// extension encrypts on write / decrypts on read).
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const daysAgo = (d) => new Date(Date.now() - d * 86400000);
const daysAhead = (d) => new Date(Date.now() + d * 86400000);

async function main() {
  const log = (m) => console.log(`[offer-backfill] ${m}`);

  const existing = await prisma.offer.count({ where: { tenantId: TENANT } });
  if (existing > 0) { log(`offers already present (${existing}) — skipping`); return; }

  // Applications with no offer yet — prefer offer-stage, add some interview-stage.
  const apps = await prisma.application.findMany({
    where: { tenantId: TENANT, offer: { is: null } },
    select: { id: true, candidateId: true, jobRequisitionId: true, stage: true },
  });
  const offerStage = apps.filter((a) => a.stage === "offer");
  const others = apps.filter((a) => a.stage === "interview").slice(0, 6);
  const targets = [...offerStage, ...others];
  log(`${targets.length} applications selected for offers (${offerStage.length} offer-stage + ${others.length} interview-stage)`);

  let created = 0;
  for (const a of targets) {
    // Status mix: mostly SENT, some ACCEPTED/DECLINED/EXPIRED, a few DRAFT.
    const status = pick(["SENT", "SENT", "ACCEPTED", "ACCEPTED", "DECLINED", "EXPIRED", "DRAFT"]);
    const sentAt = status === "DRAFT" ? null : daysAgo(3 + rnd(20));
    const respondedAt = ["ACCEPTED", "DECLINED"].includes(status) && sentAt
      ? new Date(sentAt.getTime() + (1 + rnd(6)) * 86400000) : null;
    const salary = String((90 + rnd(210)) * 1000); // 90k–300k PKR/month, plaintext → C4-encrypted
    try {
      await prisma.offer.create({ data: {
        applicationId: a.id, candidateId: a.candidateId, jobRequisitionId: a.jobRequisitionId,
        salary, currency: "PKR",
        startDate: daysAhead(15 + rnd(30)), expiryDate: daysAhead(7 + rnd(7)),
        status, sentAt, respondedAt,
        notes: status === "ACCEPTED" ? "Candidate accepted; onboarding to be scheduled."
          : status === "DECLINED" ? "Candidate declined the offer."
          : status === "DRAFT" ? "Draft offer pending approval." : "Offer extended to candidate.",
        tenantId: TENANT,
      } });
      created++;
    } catch (e) { /* applicationId unique collision — skip */ }
  }
  log(`${created} offers created`);
  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("OFFER-BACKFILL ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
