import { ensureProvisioningRequests } from "./onboardingProvisioning.service.js";
import { Prisma } from "@prisma/client";
import {
  runOnboardingManagement,
  managementChecklist,
  onboardingFailure as fail,
} from "./onboardingManagement.service.js";
import { seedTemplateSessions } from "./onboardingCalendar.service.js";
import { resolveTasksForProvisioning } from "./onboardingTemplate.service.js";
import { validateTemplateTasks } from "../lib/onboardingTemplates.js";
import { materializeOnboardingTaskRows } from "../lib/onboardingDefaults.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
const statuses = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "OVERDUE"];
const stages = [
  "pre_joining",
  "pre_boarding",
  "first_week",
  "equipment",
  "complete",
];
const id = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0)
    fail("A positive employee or checklist ID is required");
  return n;
};
const date = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    fail("Use a calendar date in YYYY-MM-DD format");
  const d = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value)
    fail("Invalid calendar date");
  return d;
};
export function normalizeOnboardingFilters(query = {}) {
  if (
    !query ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Object.keys(query).some(
      (k) =>
        ![
          "q",
          "department",
          "status",
          "stage",
          "businessUnitId",
          "startFrom",
          "startTo",
          "page",
          "pageSize",
          "sort",
          "order",
        ].includes(k),
    )
  )
    fail("Unsupported onboarding filter");
  const filters = {};
  for (const key of ["q", "department"])
    if (query[key]) {
      if (typeof query[key] !== "string" || query[key].length > 200)
        fail("Invalid " + key);
      filters[key] = query[key].trim();
    }
  for (const [key, values] of [
    ["status", statuses],
    ["stage", stages],
  ])
    if (query[key]) {
      if (!values.includes(query[key])) fail("Invalid " + key);
      filters[key] = query[key];
    }
  if (query.businessUnitId) filters.businessUnitId = id(query.businessUnitId);
  for (const key of ["startFrom", "startTo"])
    if (query[key]) filters[key] = date(query[key]).toISOString().slice(0, 10);
  if (
    filters.startFrom &&
    filters.startTo &&
    filters.startFrom > filters.startTo
  )
    fail("Start-date range is reversed");
  return filters;
}
function base(env, f) {
  const clauses = [
    Prisma.sql`c."tenantId"=${env.tenantId}::uuid`,
    Prisma.sql`e.tenant_id=${env.tenantId}::uuid`,
  ];
  if (env.scope.level === "MANAGED")
    clauses.push(Prisma.sql`e."managerId"=${env.who.id}`);
  if (f.q)
    clauses.push(
      Prisma.sql`strpos(lower(concat_ws(' ',c.title,e.employee_name,e.first_name,e.last_name)),lower(${f.q}))>0`,
    );
  if (f.status) clauses.push(Prisma.sql`c.status::text=${f.status}`);
  if (f.stage) clauses.push(Prisma.sql`c."currentStage"=${f.stage}`);
  if (f.businessUnitId)
    clauses.push(Prisma.sql`e."businessUnitId"=${f.businessUnitId}`);
  if (f.department)
    clauses.push(Prisma.sql`lower(b.name)=lower(${f.department})`);
  if (f.startFrom)
    clauses.push(Prisma.sql`c."startDate">=${date(f.startFrom)}`);
  if (f.startTo)
    clauses.push(
      Prisma.sql`c."startDate"<${new Date(+date(f.startTo) + 86400000)}`,
    );
  return Prisma.sql`WITH scoped AS(SELECT c.id,c."employeeId",c."startDate",c.status::text AS status,c."currentStage" AS stage,c."readyToCollect",NULLIF(COALESCE(NULLIF(e.employee_name,''),concat_ws(' ',e.first_name,e.last_name)),'') AS "newHireName",e.job_title AS role,b.name AS department,NULLIF(COALESCE(NULLIF(m.employee_name,''),concat_ws(' ',m.first_name,m.last_name)),'') AS manager
 FROM onboarding_checklists c JOIN "Employee" e ON e.id=c."employeeId" LEFT JOIN "BusinessUnit" b ON b.id=e."businessUnitId" AND b."tenantId"=c."tenantId" LEFT JOIN "Employee" m ON m.id=e."managerId" AND m.tenant_id=c."tenantId" WHERE ${Prisma.join(clauses, " AND ")}), task_counts AS(SELECT t."checklistId",count(*)::int AS total,count(*) FILTER(WHERE t.completed)::int AS done FROM onboarding_tasks t JOIN scoped s ON s.id=t."checklistId" WHERE t."tenantId"=${env.tenantId}::uuid GROUP BY t."checklistId"), base AS(SELECT s.*,coalesce(t.total,0)::int AS "tasksTotal",coalesce(t.done,0)::int AS "tasksDone",CASE WHEN t.total>0 THEN round(t.done*100.0/t.total)::int ELSE 0 END AS progress FROM scoped s LEFT JOIN task_counts t ON t."checklistId"=s.id)`;
}
const sortClause = (query) =>
  Prisma.sql`ORDER BY ${Prisma.raw({ startDate: '"startDate"', status: "status", progress: "progress" }[query.sort] || '"startDate"')} ${Prisma.raw(query.order === "asc" ? "ASC" : "DESC")}, id ASC`;
const view = (row) => ({ ...row, currentStage: row.stage, members: [] });
const percent = (n, d) => (d ? Math.round((n * 10000) / d) / 100 : null);
export async function getOnboardingDashboard(query = {}, tenantId) {
  return runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const filters = normalizeOnboardingFilters(query),
      sql = base(env, filters),
      page = query.page == null ? 1 : id(query.page),
      pageSize = query.pageSize == null ? 20 : id(query.pageSize);
    if (pageSize > 100 || page > 100000) fail("Page size must be at most 100");
    const now = new Date();
    const [summary] = await tx.$queryRaw(
      Prisma.sql`${sql} SELECT count(*)::int total,count(*) FILTER(WHERE status='COMPLETED')::int completed,count(*) FILTER(WHERE status='IN_PROGRESS')::int "inProgress",count(*) FILTER(WHERE status='NOT_STARTED')::int "notStarted",count(*) FILTER(WHERE status='OVERDUE')::int overdue FROM base`,
    );
    const items = await tx.$queryRaw(
      Prisma.sql`${sql} SELECT * FROM base ${sortClause(query)} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    );
    const cohorts = await tx.$queryRaw(
      Prisma.sql`${sql}, surveys AS(SELECT s.id,s."startDate",s.status,m.days,m.kind,(s."startDate"+m.days*interval '1 day'<=${now}) AS due,(v."submittedAt" IS NOT NULL AND v."submittedAt"<=${now}) AS submitted FROM scoped s CROSS JOIN (VALUES(30,'DAY_30'),(60,'DAY_60'),(90,'DAY_90'))m(days,kind) LEFT JOIN onboarding_surveys v ON v."checklistId"=s.id AND v."employeeId"=s."employeeId" AND v."tenantId"=${tenantId}::uuid AND v.type::text=m.kind) SELECT to_char("startDate",'YYYY-MM') cohort,kind,days,count(*)::int total,count(*) FILTER(WHERE status='COMPLETED')::int completed,count(*) FILTER(WHERE due)::int due,count(*) FILTER(WHERE due AND submitted)::int submitted FROM surveys GROUP BY cohort,kind,days ORDER BY cohort DESC,days ASC`,
    );
    const grouped = new Map();
    for (const row of cohorts) {
      if (!grouped.has(row.cohort))
        grouped.set(row.cohort, {
          cohort: row.cohort,
          total: row.total,
          completed: row.completed,
          completionRatePct: percent(row.completed, row.total),
          surveys: [],
        });
      grouped.get(row.cohort).surveys.push({
        type: row.kind,
        days: row.days,
        due: row.due,
        submitted: row.submitted,
        completionRatePct: percent(row.submitted, row.due),
      });
    }
    return {
      summary,
      items: items.map(view),
      page,
      pageSize,
      total: summary.total,
      totalPages: Math.ceil(summary.total / pageSize),
      sort: ["startDate", "status", "progress"].includes(query.sort)
        ? query.sort
        : "startDate",
      order: query.order === "asc" ? "asc" : "desc",
      filters,
      cohorts: [...grouped.values()],
      surveyAutomationEnabled: isRecruitmentFlagEnabled("onboarding"),
      asOf: now.toISOString(),
      cohortDefinition:
        "UTC start month; checklist completion uses COMPLETED status. Survey rates count only milestones already due for the same checklist and employee.",
    };
  });
}
export async function getOnboardingExportRows(query = {}, tenantId) {
  return runOnboardingManagement(tenantId, "EXPORT", async (tx, env) => {
    const rows = await tx.$queryRaw(
      Prisma.sql`${base(env, normalizeOnboardingFilters(query))} SELECT * FROM base ${sortClause(query)} LIMIT 10001`,
    );
    if (rows.length > 10000)
      fail("Narrow the export to at most 10,000 onboarding checklists", 413);
    return rows.map(view);
  });
}
export async function getQuickProgress(checklistId, tenantId) {
  return runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const c = await managementChecklist(tx, env, checklistId, {
        include: { employee: true, tasks: { where: { tenantId } } },
      }),
      tasks = c.tasks,
      done = tasks.filter((t) => t.completed).length,
      byStage = new Map();
    for (const t of tasks) {
      const stage = t.stage || "unassigned",
        row = byStage.get(stage) || { stage, total: 0, done: 0 };
      row.total++;
      if (t.completed) row.done++;
      byStage.set(stage, row);
    }
    return {
      id: c.id,
      newHireName:
        c.employee.employee_name ||
        [c.employee.first_name, c.employee.last_name]
          .filter(Boolean)
          .join(" ") ||
        null,
      progress: tasks.length ? Math.round((done * 100) / tasks.length) : 0,
      tasksTotal: tasks.length,
      tasksDone: done,
      byStage: [...byStage.values()],
    };
  });
}
export async function addNewHire(args, tenantId) {
  return runOnboardingManagement(tenantId, "POST", async (tx, env) => {
    const employeeId = id(args.employeeId),
      startDate = date(args.startDate);
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      tenantId + ":onboarding:" + employeeId + ":" + args.startDate,
    );
    const employee = await tx.employee.findFirst({
      where: { tenant_id: tenantId, id: employeeId },
    });
    if (!employee) fail("Employee not found", 404);
    if (
      /inactive|terminated|exited|offboard|separated/i.test(
        [employee.status, employee.employement_status].join(" "),
      )
    )
      fail("An active employee is required", 409);
    if (
      await tx.onboardingChecklist.findFirst({
        where: { tenantId, employeeId, startDate },
      })
    )
      fail("Onboarding already exists for this employee and start date", 409);
    let plan = await resolveTasksForProvisioning(tx, tenantId);
    if (args.templateId) {
      const template = await tx.onboardingChecklistTemplate.findFirst({
        where: { tenantId, id: id(args.templateId), isActive: true },
      });
      if (!template) fail("Onboarding template not found", 404);
      const valid = validateTemplateTasks(template.tasks);
      if (!valid.ok) fail("The selected template requires correction", 409);
      plan = {
        tasks: valid.tasks,
        templateId: template.id,
        source: "TEMPLATE",
      };
    }
    let buddyId = null;
    if (args.buddyId) {
      buddyId = id(args.buddyId);
      if (buddyId === employeeId) fail("Choose a different employee as buddy");
      const buddy = await tx.employee.findFirst({
        where: { tenant_id: tenantId, id: buddyId },
      });
      if (
        !buddy ||
        /inactive|terminated|exited|offboard|separated/i.test(
          [buddy.status, buddy.employement_status].join(" "),
        )
      )
        fail("Active buddy not found", 404);
    }
    const created = await tx.onboardingChecklist.create({
      data: {
        tenantId,
        employeeId,
        startDate,
        title:
          typeof args.title === "string" && args.title.trim()
            ? args.title.trim().slice(0, 200)
            : "Employee Onboarding",
        status: "NOT_STARTED",
        currentStage: "pre_joining",
        template: plan.templateId ? "template:" + plan.templateId : null,
      },
    });
    await tx.onboardingTask.createMany({
      data: materializeOnboardingTaskRows({
        ...plan,
        tenantId,
        checklistId: created.id,
        startDate,
      }),
    });
    await seedTemplateSessions(tx,tenantId,created.id,plan.tasks);
    await ensureProvisioningRequests(tx, tenantId, created.id);
    if (buddyId)
      await tx.onboardingBuddy.create({
        data: { tenantId, checklistId: created.id, buddyId },
      });
    const event = await enqueueHrDomainEvent(tx, {
      tenantId,
      eventName: "hr.onboarding.checklist_created.v1",
      aggregateType: "OnboardingChecklist",
      aggregateId: String(created.id),
      payload: {
        checklistId: String(created.id),
        employeeId: String(employeeId),
        actorId: String(env.who.id),
      },
    });
    if (!event) fail("Onboarding creation event was not saved", 503);
    return {
      id: created.id,
      employeeId,
      startDate: created.startDate,
      status: created.status,
      templateId: plan.templateId,
      tasksCreated: plan.tasks.length,
      buddyId,
    };
  });
}
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
export const EXPORT_COLUMNS = [
  { key: "newHireName", header: "New Hire" },
  { key: "role", header: "Role" },
  { key: "department", header: "Department" },
  { key: "manager", header: "Manager" },
  { key: "startDate", header: "Start Date", value: (r) => day(r.startDate) },
  { key: "stage", header: "Stage" },
  { key: "progress", header: "Progress (%)" },
  { key: "tasksDone", header: "Tasks Completed" },
  { key: "tasksTotal", header: "Tasks Total" },
  { key: "status", header: "Status" },
];
