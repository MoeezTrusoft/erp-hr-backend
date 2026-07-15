// src/services/onboardingDashboard.service.js — Onboarding Dashboard read/write
// surface. Tenant-scoped over OnboardingChecklist. Provides:
//   * dashboard list (summary + shaped items) w/ search / filter / sort / paging
//   * add-new-hire (create a checklist + optional seeded tasks per template)
//   * export rows (flat table for csv/pdf/png)
//   * quick-progress (per-checklist progress breakdown by stage)
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { scopedData } from "../lib/tenancy.js";
import { parseListQuery, buildListPayload } from "../utils/apiContract.js";

// ── name helpers ──────────────────────────────────────────────────────────
const employeeName = (e) =>
  e?.employee_name || [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() || null;

// Client-supplied dashboard sorts. `progress` is not a column, so it is sorted
// in-memory after the DB read (below).
const DB_SORTS = ["startDate", "status"];

// Default task seeds keyed by template name. Each entry maps a stage → task
// titles that are created (uncompleted) alongside a new checklist.
const TEMPLATE_TASK_SEEDS = {
  default: {
    pre_joining: ["Send offer paperwork", "Collect signed documents"],
    pre_boarding: ["Provision email account", "Prepare workspace"],
    first_week: ["Team introduction", "Assign first-week goals"],
    equipment: ["Issue laptop", "Grant system access"],
  },
  engineering: {
    pre_joining: ["Send offer paperwork", "Collect signed documents"],
    pre_boarding: ["Provision email account", "Add to repositories"],
    first_week: ["Dev environment setup", "Assign onboarding buddy tasks"],
    equipment: ["Issue laptop", "Grant CI/CD & VPN access"],
  },
  sales: {
    pre_joining: ["Send offer paperwork", "Collect signed documents"],
    pre_boarding: ["Provision CRM account", "Prepare workspace"],
    first_week: ["Product training", "Shadow a senior rep"],
    equipment: ["Issue laptop", "Provision phone & headset"],
  },
};

const seedForTemplate = (template) =>
  TEMPLATE_TASK_SEEDS[template] || TEMPLATE_TASK_SEEDS.default;

// ── list / dashboard ─────────────────────────────────────────────────────
const buildDashboardWhere = (query, tenantId, q) => {
  const status = query.status || null;
  const businessUnitId =
    query.businessUnitId != null && query.businessUnitId !== ""
      ? Number(query.businessUnitId)
      : null;
  const department = query.department || null;

  const employeeUnitFilter = businessUnitId
    ? { employee: { is: { businessUnitId } } }
    : department
      ? { employee: { is: { businessUnit: { is: { name: { equals: department, mode: "insensitive" } } } } } }
      : {};

  return {
    where: {
      AND: [
        scopedWhere(tenantId, {}),
        q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { employee: { is: { employee_name: { contains: q, mode: "insensitive" } } } },
                { employee: { is: { first_name: { contains: q, mode: "insensitive" } } } },
                { employee: { is: { last_name: { contains: q, mode: "insensitive" } } } },
              ],
            }
          : {},
        status ? { status } : {},
        employeeUnitFilter,
      ],
    },
    filters: { status, department, businessUnitId },
  };
};

const checklistInclude = {
  employee: {
    select: {
      id: true,
      employee_name: true,
      first_name: true,
      last_name: true,
      job_title: true,
      businessUnitId: true,
      businessUnit: { select: { name: true } },
      manager: { select: { employee_name: true, first_name: true, last_name: true } },
    },
  },
  tasks: { select: { completed: true, stage: true } },
};

const shapeItem = (c) => {
  const tasks = c.tasks || [];
  const done = tasks.filter((t) => t.completed).length;
  const members = Array.isArray(c.memberAssignments) ? c.memberAssignments : [];
  return {
    id: c.id,
    employeeId: c.employeeId,
    newHireName: employeeName(c.employee),
    role: c.employee?.job_title ?? null,
    department: c.employee?.businessUnit?.name ?? null,
    startDate: c.startDate,
    stage: c.currentStage ?? null,
    currentStage: c.currentStage ?? null,
    manager: employeeName(c.employee?.manager),
    progress: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    members,
    readyToCollect: !!c.readyToCollect,
    status: c.status,
  };
};

const summarize = (rows) => {
  const summary = { total: rows.length, completed: 0, inProgress: 0, notStarted: 0, overdue: 0 };
  for (const r of rows) {
    if (r.status === "COMPLETED") summary.completed += 1;
    else if (r.status === "IN_PROGRESS") summary.inProgress += 1;
    else if (r.status === "NOT_STARTED") summary.notStarted += 1;
    else if (r.status === "OVERDUE") summary.overdue += 1;
  }
  return summary;
};

// Fetch every scoped item (shaped) for a query. Shared by list + export +
// summary so the summary counts the whole filtered set, not just one page.
const fetchDashboardItems = async (query, tenantId) => {
  const q = query.q || query.search || "";
  const { where, filters } = buildDashboardWhere(query, tenantId, q);
  const rows = await prisma.onboardingChecklist.findMany({
    where,
    include: checklistInclude,
  });
  return { items: rows.map(shapeItem), filters };
};

const applySort = (items, sort, order) => {
  const dir = order === "asc" ? 1 : -1;
  const sorted = [...items];
  if (sort === "progress") {
    sorted.sort((a, b) => (a.progress - b.progress) * dir);
  } else if (sort === "status") {
    sorted.sort((a, b) => String(a.status).localeCompare(String(b.status)) * dir);
  } else {
    // startDate (default)
    sorted.sort((a, b) => (new Date(a.startDate) - new Date(b.startDate)) * dir);
  }
  return sorted;
};

/**
 * Dashboard payload: summary over the whole filtered set + a paginated,
 * sorted, shaped items list.
 */
export const getOnboardingDashboard = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "startDate" });
  const { items, filters } = await fetchDashboardItems(query, tenantId);

  const summary = summarize(items);

  const sort = ["startDate", "status", "progress"].includes(list.sort) ? list.sort : "startDate";
  const sorted = applySort(items, sort, list.order);
  const paged = sorted.slice(list.skip, list.skip + list.pageSize);

  const payload = buildListPayload({
    ...list,
    sort,
    total: items.length,
    filters,
    items: paged,
  });
  return { summary, ...payload };
};

// ── add new hire ───────────────────────────────────────────────────────────
/**
 * Create an OnboardingChecklist for a new hire (NOT_STARTED, pre_joining stage)
 * and optionally seed default tasks for the chosen template. Returns the
 * created checklist with employee + tasks included.
 */
export const addNewHire = async (args, tenantId) => {
  const {
    employeeId,
    startDate,
    department,
    managerId,
    template,
    members,
    title,
  } = args;

  const empId = Number(employeeId);
  if (!Number.isFinite(empId)) {
    throw Object.assign(new Error("employeeId must be numeric"), { status: 400 });
  }

  const seeds = seedForTemplate(template);
  const seededTasks = Object.entries(seeds).flatMap(([stage, titles], stageIdx) =>
    titles.map((t, i) => ({
      title: t,
      stage,
      assigneeType: "HR",
      completed: false,
      sortOrder: stageIdx * 10 + i,
      ...scopedData(tenantId, {}),
    }))
  );

  const created = await prisma.onboardingChecklist.create({
    data: {
      ...scopedData(tenantId, {}),
      employeeId: empId,
      title: title || "Onboarding",
      startDate: new Date(startDate),
      status: "NOT_STARTED",
      currentStage: "pre_joining",
      template: template || null,
      memberAssignments: Array.isArray(members) ? members : [],
      activityLog: [
        {
          at: new Date().toISOString(),
          actor: "system",
          text: "New hire onboarding created",
        },
      ],
      ...(seededTasks.length ? { tasks: { create: seededTasks } } : {}),
    },
    include: checklistInclude,
  });

  // department / managerId are informational hints from the dashboard form; the
  // authoritative values live on the Employee record. We echo them back in the
  // response but do not mutate Employee here.
  return { ...created, _hints: { department: department ?? null, managerId: managerId ?? null } };
};

// ── export ───────────────────────────────────────────────────────────────
const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

export const EXPORT_COLUMNS = [
  { key: "newHireName", header: "New Hire", value: (r) => r.newHireName || "-" },
  { key: "role", header: "Role", value: (r) => r.role || "-" },
  { key: "department", header: "Department", value: (r) => r.department || "-" },
  { key: "manager", header: "Manager", value: (r) => r.manager || "-" },
  { key: "startDate", header: "Start Date", value: (r) => fmtDate(r.startDate) },
  { key: "stage", header: "Stage", value: (r) => r.stage || "-" },
  { key: "progress", header: "Progress", value: (r) => `${r.progress}%` },
  { key: "status", header: "Status" },
];

/**
 * Flat, sorted rows for the export tool (whole filtered set, no paging).
 */
export const getOnboardingExportRows = async (query, tenantId) => {
  const { items } = await fetchDashboardItems(query, tenantId);
  const order = query.order === "asc" ? "asc" : "desc";
  const sort = ["startDate", "status", "progress"].includes(query.sort) ? query.sort : "startDate";
  return applySort(items, sort, order);
};

// ── quick progress ─────────────────────────────────────────────────────────
/**
 * Per-checklist quick-progress breakdown: overall progress + per-stage totals.
 */
export const getQuickProgress = async (id, tenantId) => {
  const checklistId = Number(id);
  const c = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { id: checklistId }),
    include: checklistInclude,
  });
  if (!c) throw Object.assign(new Error("Onboarding checklist not found"), { status: 404 });

  const tasks = c.tasks || [];
  const tasksDone = tasks.filter((t) => t.completed).length;

  const stageMap = new Map();
  for (const t of tasks) {
    const stage = t.stage || "unassigned";
    const entry = stageMap.get(stage) || { stage, total: 0, done: 0 };
    entry.total += 1;
    if (t.completed) entry.done += 1;
    stageMap.set(stage, entry);
  }

  return {
    id: c.id,
    newHireName: employeeName(c.employee),
    progress: tasks.length ? Math.round((tasksDone / tasks.length) * 100) : 0,
    tasksTotal: tasks.length,
    tasksDone,
    byStage: [...stageMap.values()],
  };
};
