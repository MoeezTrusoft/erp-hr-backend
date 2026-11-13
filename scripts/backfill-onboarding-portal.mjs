// scripts/backfill-onboarding-portal.mjs — populate the onboarding portal fields
// on the 12 existing checklists so every portal screen has data. Idempotent-ish.
// Tenant Company 1. Run in a node:24 pod with the NEW client.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const daysAgo = (d) => new Date(Date.now() - d * 86400000);
const daysAhead = (d) => new Date(Date.now() + d * 86400000);
const STAGES = ["pre_joining", "pre_boarding", "first_week", "equipment"];
const bools = (keys, pTrue) => Object.fromEntries(keys.map((k) => [k, Math.random() < pTrue]));

const READINESS = ["documentsReceived", "personalInfoComplete", "vpnAccessEnabled", "joiningDateConfirmed"];
const ITSETUP = ["companyEmailCreated", "systemAccessAssigned", "personalEmailComplete", "communicationToolSetup"];
const ENGAGE = ["welcomeEmailSent", "introVideoWatched", "firstDayAgendaReviewed"];
const WORKSPACE = ["laptopAssigned", "idCardPrepared", "deskAllocated", "softwareInstalled", "accessoriesAllocated"];
const SESSIONS = [
  { title: "Orientation & Welcome", sessionType: "orientation", location: "Boardroom A" },
  { title: "IT & Systems Setup", sessionType: "meeting", location: "IT Desk" },
  { title: "Team Introduction", sessionType: "meeting", location: "Google Meet" },
];
const COMMENTS = ["Great onboarding experience.", "Clear process, helpful team.", "Could improve IT setup speed.", "Very welcoming team."];

async function main() {
  const log = (m) => console.log(`[ob-portal] ${m}`);
  const empPool = (await prisma.employee.findMany({ select: { id: true, employee_name: true, first_name: true, last_name: true, job_title: true }, take: 60 }));
  const nameOf = (e) => e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ");

  const lists = await prisma.onboardingChecklist.findMany({
    where: { tenantId: TENANT },
    select: { id: true, status: true, currentStage: true, template: true, tasks: { select: { id: true, stage: true } } },
  });
  log(`${lists.length} checklists`);

  let sessCount = 0, surveyCount = 0;
  for (const cl of lists) {
    const pTrue = cl.status === "COMPLETED" ? 0.95 : cl.status === "IN_PROGRESS" ? 0.6 : cl.status === "OVERDUE" ? 0.4 : 0.2;
    const preboarding = {
      readiness: bools(READINESS, pTrue), itSetup: bools(ITSETUP, pTrue),
      engagement: bools(ENGAGE, pTrue), workspace: bools(WORKSPACE, pTrue),
    };
    const readyToCollect = Object.values(preboarding.readiness).every(Boolean) && Object.values(preboarding.itSetup).every(Boolean);
    const members = [pick(empPool), pick(empPool)].map((e) => ({ employeeId: e.id, name: nameOf(e), role: e.job_title || "Team Member" }));
    const currentStage = cl.status === "COMPLETED" ? "complete" : cl.status === "NOT_STARTED" ? "pre_joining" : pick(["pre_boarding", "first_week", "equipment"]);
    await prisma.onboardingChecklist.update({ where: { id: cl.id }, data: {
      template: "Standard Onboarding", currentStage, readyToCollect,
      preboarding, memberAssignments: members,
      activityLog: [
        { at: daysAgo(5).toISOString(), actor: "HR", text: "Onboarding checklist created." },
        { at: daysAgo(2).toISOString(), actor: "HR", text: "Buddy assigned and welcome email sent." },
      ],
    } });

    // task stages
    for (let i = 0; i < cl.tasks.length; i++) {
      if (!cl.tasks[i].stage) await prisma.onboardingTask.update({ where: { id: cl.tasks[i].id }, data: { stage: STAGES[i % STAGES.length] } });
    }

    // sessions (only if none)
    const haveSess = await prisma.onboardingSession.count({ where: { checklistId: cl.id } });
    if (haveSess === 0) {
      for (let i = 0; i < SESSIONS.length; i++) {
        const s = SESSIONS[i];
        await prisma.onboardingSession.create({ data: {
          checklistId: cl.id, title: s.title, sessionType: s.sessionType, location: s.location,
          sessionDate: daysAhead(1 + i * 2), fromTime: `${9 + i}:00`, toTime: `${10 + i}:00`,
          assigneeId: pick(empPool).id, tenantId: TENANT,
        } });
        sessCount++;
      }
    }

    // feedback survey for completed/in-progress (only if none)
    if (cl.status === "COMPLETED" || cl.status === "IN_PROGRESS") {
      const emp = await prisma.onboardingChecklist.findUnique({ where: { id: cl.id }, select: { employeeId: true } });
      const haveSurvey = await prisma.onboardingSurvey.count({ where: { checklistId: cl.id } });
      if (haveSurvey === 0) {
        await prisma.onboardingSurvey.create({ data: {
          checklistId: cl.id, employeeId: emp.employeeId, type: "DAY_30",
          responses: { ratings: { roleClarity: pick(["very_clear", "somewhat_clear", "very_clear"]), teamSupport: pick(["yes", "yes", "neutral"]), onboardingProcess: 3 + rnd(3) }, comments: pick(COMMENTS) },
          submittedAt: daysAgo(rnd(10)), tenantId: TENANT,
        } });
        surveyCount++;
      }
    }
  }
  log(`updated ${lists.length} checklists; sessions +${sessCount}; surveys +${surveyCount}`);
  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("OB-PORTAL ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
