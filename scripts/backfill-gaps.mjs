// scripts/backfill-gaps.mjs — fill the two gap areas: Candidate.location + seed
// OnboardingChecklists (with tasks + buddy) so the onboarding list has data.
// Idempotent. Tenant Company 1. Run in a node:24 pod with the NEW client.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const daysAgo = (d) => new Date(Date.now() - d * 86400000);
const daysAhead = (d) => new Date(Date.now() + d * 86400000);

const CITIES = ["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan"];
const TASKS = [
  { title: "Sign employment contract", assigneeType: "NEW_HIRE" },
  { title: "Provision laptop & accounts", assigneeType: "IT" },
  { title: "Complete HR paperwork", assigneeType: "HR" },
  { title: "Team introduction & 1:1 with manager", assigneeType: "MANAGER" },
  { title: "Security & compliance training", assigneeType: "NEW_HIRE" },
];

async function main() {
  const log = (m) => console.log(`[gaps] ${m}`);

  // 1) Candidate.location
  const cands = await prisma.candidate.findMany({ where: { tenantId: TENANT }, select: { id: true, location: true } });
  let lc = 0;
  for (const c of cands) {
    if (c.location == null || c.location === "") {
      await prisma.candidate.update({ where: { id: c.id }, data: { location: pick(CITIES) } });
      lc++;
    }
  }
  log(`candidate location set on ${lc}/${cands.length}`);

  // 2) Seed onboarding checklists (only if none exist for the tenant)
  const existing = await prisma.onboardingChecklist.count({ where: { tenantId: TENANT } });
  if (existing > 0) { log(`onboarding checklists already present (${existing}) — skipping seed`); log("DONE."); return; }

  // Most-recently-hired employees get an onboarding record.
  const emps = await prisma.employee.findMany({
    where: {}, select: { id: true, hire_date: true, joining_date: true },
    orderBy: { hire_date: "desc" }, take: 12,
  });
  const buddyPool = (await prisma.employee.findMany({ select: { id: true }, take: 40 })).map((e) => e.id);
  const STATUSES = ["NOT_STARTED", "IN_PROGRESS", "IN_PROGRESS", "COMPLETED", "OVERDUE"];
  let cc = 0, tc = 0;
  for (const e of emps) {
    const start = e.joining_date || e.hire_date || daysAgo(20);
    const status = pick(STATUSES);
    const cl = await prisma.onboardingChecklist.create({ data: {
      employeeId: e.id, title: "New Hire Onboarding",
      startDate: start, targetDate: new Date(new Date(start).getTime() + 30 * 86400000),
      status, completedAt: status === "COMPLETED" ? daysAgo(rnd(10)) : null,
      notes: "Standard onboarding program.", tenantId: TENANT,
    } });
    cc++;
    // tasks
    const nDone = status === "COMPLETED" ? TASKS.length : status === "IN_PROGRESS" ? 2 + rnd(2) : status === "OVERDUE" ? 1 + rnd(2) : 0;
    for (let i = 0; i < TASKS.length; i++) {
      const done = i < nDone;
      await prisma.onboardingTask.create({ data: {
        checklistId: cl.id, title: TASKS[i].title, assigneeType: TASKS[i].assigneeType,
        assigneeId: e.id, dueDate: daysAhead(3 + i * 2), completed: done,
        completedAt: done ? daysAgo(rnd(15)) : null, sortOrder: i, tenantId: TENANT,
      } });
      tc++;
    }
    // buddy
    const buddyId = pick(buddyPool.filter((id) => id !== e.id));
    if (buddyId) {
      await prisma.onboardingBuddy.create({ data: { checklistId: cl.id, buddyId, notes: "Assigned onboarding buddy.", tenantId: TENANT } });
    }
  }
  log(`onboarding checklists seeded: ${cc} (+${tc} tasks + buddies)`);
  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("GAPS-BACKFILL ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
