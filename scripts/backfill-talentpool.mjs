// scripts/backfill-talentpool.mjs — add existing candidates to named talent
// pools on the live tenant. Idempotent: no-op if talent-pool rows exist.
// Depends on candidates from backfill-interviews.mjs. Anchored to Company 1.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const sample = (a, k) => { const c = [...a]; const o = []; while (o.length < k && c.length) o.push(c.splice(rnd(c.length), 1)[0]); return o; };

const POOLS = [
  "Engineering — Silver Medalists",
  "Future Leaders",
  "Design Bench",
  "Sales Pipeline",
  "Rehire / Boomerang",
  "Passive — Long-term Nurture",
];
const NOTES = [
  "Strong candidate, no open role right now — nurture for next cycle.",
  "Reached final round; keep warm for the next opening.",
  "Great culture fit; revisit when a matching req opens.",
  "Referred by a current employee; high potential.",
];

async function main() {
  const log = (m) => console.log(`[talentpool-backfill] ${m}`);

  const existing = await prisma.talentPool.count({ where: { tenantId: TENANT } });
  if (existing > 0) { log(`talent-pool rows already present (${existing}) — skipping`); return; }

  const cands = await prisma.candidate.findMany({ where: { tenantId: TENANT }, select: { id: true } });
  if (cands.length === 0) { log("no candidates — run backfill-interviews first"); return; }
  const candIds = cands.map((c) => c.id);
  log(`${candIds.length} candidates available`);

  // Add ~60% of candidates to 1–2 pools each.
  const chosen = sample(candIds, Math.ceil(candIds.length * 0.6));
  let created = 0;
  for (const candidateId of chosen) {
    for (const poolName of sample(POOLS, 1 + rnd(2))) {
      try {
        await prisma.talentPool.create({ data: {
          candidateId, poolName, notes: pick(NOTES), tenantId: TENANT,
        } });
        created++;
      } catch (e) { /* unique [candidateId, poolName] collision — skip */ }
    }
  }
  log(`${created} talent-pool memberships created across ${POOLS.length} pools`);
  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("TALENTPOOL-BACKFILL ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
