// src/services/employeeProfileTabs.service.js — TAB-SCOPED employee profile.
//
// hr_employee_profile_get fetches ONE tab's data per call (not everything at
// once) plus a light always-on identity header. Tabs:
//   overview      — skills & competencies, leave balance, last review, attendance, projects(PM)
//   job_and_comp  — full comp/bank/tax (employeeProfile.service) + CTC/basic/allowances/bonus/equity
//   performance   — goals, performance potential (calibration), recognition
//   leaves        — upcoming leaves + team coverage, holidays, hours completed
//   training      — courses done, avg score, certificates, active learning path, recommended, timeline
//   activity      — last login, device, 2FA, sessions(30d), failed attempts, permissions/roles (RBAC)
//
// Reads go through the C4-extended prisma singleton (decrypts salary/equity).
// Cross-service tabs (overview.projects → PM, activity → RBAC) are fail-soft.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { scopedEmployeeWhere } from "../lib/tenancy.js";
import { getUserByEmployeeId } from "./rbac.client.js";
import { getEmployeeActivity } from "./rbacActivity.client.js";
import { getEmployeeProjects } from "./pmProjects.client.js";
import { getEmployeeConsolidatedProfile } from "./employeeProfile.service.js";

export const PROFILE_TABS = ["overview", "job_and_comp", "performance", "leaves", "training", "activity"];

const FREQ_PER_YEAR = { WEEKLY: 52, BI_WEEKLY: 26, SEMI_MONTHLY: 24, MONTHLY: 12 };
const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const employeeName = (e) =>
  e?.employee_name || [e?.first_name, e?.middle_name, e?.last_name].filter(Boolean).join(" ") || null;

const startOfMonth = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const now = () => new Date();
const daysFromNow = (n) => new Date(Date.now() + n * 86400000);

// ---------------------------------------------------------------- header ----
async function buildHeader(employee, org) {
  return {
    employeeId: employee.id,
    employeeCode: employee.employee_code,
    name: employeeName(employee),
    firstName: employee.first_name,
    middleName: employee.middle_name,
    lastName: employee.last_name,
    jobTitle: employee.job_title ?? employee.Position?.title ?? null,
    photoUrl: employee.photo_url ?? null,
    status: employee.status || employee.employement_status || null,
    payGrade: employee.gradeLevel?.name ?? null,
    companyName: org?.companyName ?? null,
    departments: org?.departments ?? [],
    departmentName: org?.departments?.[0] ?? null,
  };
}

// -------------------------------------------------------------- overview ----
async function overviewTab(id, tenantId, ctx) {
  const [skillRows, leaveBalances, lastReview, attendanceRows, projects] = await Promise.all([
    prisma.employeeSkill.findMany({
      where: { employeeId: id },
      include: { skill: { select: { name: true, category: true } } },
      orderBy: [{ addedAt: "desc" }],
    }),
    prisma.leaveBalance.findMany({
      where: { employeeId: id },
      include: { leavePolicy: { select: { name: true, leaveTypeCode: true } } },
    }),
    prisma.performanceReview.findFirst({
      where: { employeeId: id },
      orderBy: [{ submittedAt: "desc" }, { created_at: "desc" }],
      select: { id: true, overall_rating: true, status: true, type: true, period_start: true, period_end: true, submittedAt: true },
    }),
    prisma.attendance.findMany({
      where: { employeeId: id, date: { gte: startOfMonth(), lte: now() } },
      select: { status: true, total_hours: true },
    }),
    ctx.userId ? getEmployeeProjects(ctx.userId) : Promise.resolve({ available: false, items: [], reason: "no linked userId" }),
  ]);

  const mapSkill = (es) => ({
    name: es.skill?.name ?? null,
    category: es.skill?.category ?? null,
    score: es.score ?? null,
    level: es.level ?? es.proficiency ?? null,
  });
  const all = skillRows.map(mapSkill);
  const attendance = attendanceRows.reduce(
    (acc, a) => {
      const s = String(a.status || "").toUpperCase();
      if (s === "PRESENT") acc.present += 1;
      else if (s === "ABSENT") acc.absent += 1;
      else if (s === "LATE") acc.late += 1;
      acc.totalHours += num(a.total_hours) || 0;
      return acc;
    },
    { present: 0, absent: 0, late: 0, totalHours: 0, period: "this-month" }
  );

  return {
    skills: all.filter((s) => String(s.category || "").toLowerCase() !== "competency"),
    competencies: all.filter((s) => String(s.category || "").toLowerCase() === "competency"),
    leaveBalance: leaveBalances.map((b) => ({
      policy: b.leavePolicy?.name ?? null,
      leaveTypeCode: b.leavePolicy?.leaveTypeCode ?? null,
      balance: num(b.balance),
      carryOver: num(b.carryOverBalance),
    })),
    lastReview: lastReview
      ? { id: lastReview.id, rating: num(lastReview.overall_rating), status: lastReview.status, type: lastReview.type, periodStart: lastReview.period_start, periodEnd: lastReview.period_end, submittedAt: lastReview.submittedAt }
      : null,
    attendance,
    projects: projects.available
      ? { available: true, items: projects.items }
      : { available: false, reason: projects.reason, items: [] },
  };
}

// ------------------------------------------------------------ job & comp ----
async function jobCompTab(id, tenantId, ctx) {
  // Full comp/bank/tax block (reuse the consolidated builder; skip its RBAC call).
  const consolidated = await getEmployeeConsolidatedProfile(id, tenantId, {
    showSensitive: ctx.showSensitive,
    taxFiscalYear: ctx.taxFiscalYear,
    org: ctx.org,
  });

  // CTC breakdown: basic + allowances (active earning-type assignments) + bonus + equity.
  const current = consolidated.compensation?.current ?? null;
  const assignments = await prisma.payrollAssignment.findMany({
    where: { employeeId: id, isActive: true, earningTypeId: { not: null } },
    include: { earningType: { select: { name: true, type: true } } },
  });
  const allowanceRows = assignments
    .filter((a) => String(a.earningType?.type || "EARNING").toUpperCase() === "EARNING")
    .map((a) => ({ name: a.earningType?.name ?? null, amount: num(a.amount), rate: num(a.rate) }));

  let ctc = null;
  if (ctx.showSensitive && current) {
    const freq = FREQ_PER_YEAR[current.payFrequency] || 12;
    const basic = num(current.baseSalary) || 0;
    const allowancesPerPeriod = allowanceRows.reduce((s, a) => s + (a.amount || 0), 0);
    const bonus = num(current.bonusTarget) || 0; // treated as annual target
    ctc = Math.round((basic + allowancesPerPeriod) * freq + bonus);
  }

  return {
    ...consolidated,
    ctc: {
      annualCTC: ctc, // null unless sensitive
      basicSalary: ctx.showSensitive ? num(current?.baseSalary) : null,
      variableBonus: ctx.showSensitive ? num(current?.bonusTarget) : null,
      equity: ctx.showSensitive ? (current?.equity ?? null) : null,
      currency: current?.currency ?? null,
      payFrequency: current?.payFrequency ?? null,
      allowances: ctx.showSensitive ? allowanceRows : allowanceRows.map((a) => ({ name: a.name, amount: null, rate: null })),
      restricted: !ctx.showSensitive,
    },
  };
}

// ----------------------------------------------------------- performance ----
async function performanceTab(id, tenantId) {
  const [goals, potentialAdj, lastReview, recognitions] = await Promise.all([
    prisma.goal.findMany({
      where: { employeeId: id },
      orderBy: [{ end_date: "desc" }],
      take: 25,
      select: { id: true, title: true, category: true, status: true, progress: true, target_value: true, current_value: true, start_date: true, end_date: true },
    }),
    prisma.ratingAdjustment.findFirst({
      where: { performance_review: { employeeId: id } },
      orderBy: [{ created_at: "desc" }],
      select: { new_rating: true, old_rating: true, created_at: true, justification: true },
    }),
    prisma.performanceReview.findFirst({
      where: { employeeId: id },
      orderBy: [{ submittedAt: "desc" }, { created_at: "desc" }],
      select: { overall_rating: true },
    }),
    prisma.recognition.findMany({
      where: { employeeId: id },
      orderBy: [{ awardedAt: "desc" }],
      take: 25,
      select: { id: true, title: true, description: true, category: true, awardedAt: true },
    }),
  ]);

  // Potential: calibrated rating if present, else last review's overall rating.
  const potential = potentialAdj
    ? { rating: num(potentialAdj.new_rating), source: "calibration", note: potentialAdj.justification ?? null, at: potentialAdj.created_at }
    : lastReview?.overall_rating != null
      ? { rating: num(lastReview.overall_rating), source: "review", note: null, at: null }
      : null;

  return {
    goals: goals.map((g) => ({
      id: g.id, title: g.title, category: g.category, status: g.status,
      progress: num(g.progress), targetValue: num(g.target_value), currentValue: num(g.current_value),
      startDate: g.start_date, endDate: g.end_date,
    })),
    goalSummary: {
      total: goals.length,
      completed: goals.filter((g) => String(g.status).toUpperCase() === "COMPLETED").length,
      inProgress: goals.filter((g) => String(g.status).toUpperCase() === "IN_PROGRESS").length,
    },
    performancePotential: potential,
    recognition: {
      count: recognitions.length,
      items: recognitions.map((r) => ({ id: r.id, title: r.title, description: r.description, category: r.category, awardedAt: r.awardedAt })),
    },
  };
}

// ---------------------------------------------------------------- leaves ----
async function leavesTab(id, tenantId, employee) {
  const windowEnd = daysFromNow(30);
  const [upcoming, teammates] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { employeeId: id, startDate: { gte: now() }, status: { in: ["PENDING", "APPROVED"] } },
      orderBy: [{ startDate: "asc" }],
      take: 20,
      include: { leavePolicy: { select: { name: true } } },
    }),
    employee.managerId
      ? prisma.employee.findMany({
          where: { managerId: employee.managerId, id: { not: id } },
          select: { id: true, employee_name: true, first_name: true, last_name: true },
          take: 50,
        })
      : Promise.resolve([]),
  ]);

  // Team coverage: teammates (same manager) with APPROVED leave overlapping next 30d.
  let teamCoverage = [];
  if (teammates.length) {
    const teammateIds = teammates.map((t) => t.id);
    const teamLeaves = await prisma.leaveRequest.findMany({
      where: {
        employeeId: { in: teammateIds },
        status: "APPROVED",
        startDate: { lte: windowEnd },
        endDate: { gte: now() },
      },
      select: { employeeId: true, startDate: true, endDate: true },
    });
    const byId = new Map(teammates.map((t) => [t.id, employeeName(t)]));
    teamCoverage = teamLeaves.map((l) => ({ employeeId: l.employeeId, name: byId.get(l.employeeId) ?? null, startDate: l.startDate, endDate: l.endDate }));
  }

  // Holidays: the employee's active holiday-calendar upcoming holidays (next 90d).
  const empCals = await prisma.employeeHolidayCalendar.findMany({
    where: { employeeId: id, OR: [{ effectiveTo: null }, { effectiveTo: { gte: now() } }] },
    select: { holidayCalendarId: true },
  });
  const calIds = empCals.map((c) => c.holidayCalendarId);
  const holidays = calIds.length
    ? await prisma.holiday.findMany({
        where: { holidayCalendarId: { in: calIds }, date: { gte: now(), lte: daysFromNow(90) } },
        orderBy: [{ date: "asc" }],
        take: 20,
        select: { date: true, name: true, fullDay: true },
      })
    : [];

  // Hours completed this month (Timesheet.total_hours).
  const timesheets = await prisma.timesheet.findMany({
    where: { employeeId: id, period_start: { gte: startOfMonth() } },
    select: { total_hours: true, status: true, period_start: true, period_end: true },
  });
  const hoursCompleted = timesheets.reduce((s, t) => s + (num(t.total_hours) || 0), 0);

  return {
    upcomingLeaves: upcoming.map((l) => ({ id: l.id, policy: l.leavePolicy?.name ?? null, startDate: l.startDate, endDate: l.endDate, totalDays: num(l.totalDays), status: l.status })),
    teamCoverage,
    holidays: holidays.map((h) => ({ date: h.date, name: h.name, fullDay: h.fullDay })),
    hoursCompleted: { hours: Math.round(hoursCompleted * 100) / 100, period: "this-month", timesheets: timesheets.length },
  };
}

// -------------------------------------------------------------- training ----
async function trainingTab(id, tenantId) {
  const [enrollments, certifications, learningPaths, recentLogs] = await Promise.all([
    prisma.trainingEnrollment.findMany({
      where: { employeeId: id },
      select: { id: true, courseId: true, status: true, progress: true, score: true, completionDate: true, course: { select: { title: true } } },
      orderBy: [{ enrollmentDate: "desc" }],
    }),
    prisma.certification.findMany({
      where: { employeeId: id },
      orderBy: [{ issuedAt: "desc" }],
      select: { id: true, name: true, issuedBy: true, issuedAt: true, expiryDate: true, credentialId: true },
    }),
    prisma.learningPathEnrollment.findMany({
      where: { employeeId: id, status: { in: ["ENROLLED", "IN_PROGRESS"] } },
      include: { learningPath: { select: { name: true, targetRole: true, durationHours: true } } },
      orderBy: [{ enrolledAt: "desc" }],
    }),
    prisma.log.findMany({
      where: { employeeId: id },
      orderBy: [{ created_at: "desc" }],
      take: 12,
      select: { id: true, type: true, action_type: true, module: true, result: true, notes: true, created_at: true },
    }),
  ]);

  const completed = enrollments.filter((e) => String(e.status).toUpperCase() === "COMPLETED");
  const scored = completed.filter((e) => e.score != null);
  const avgScore = scored.length ? Math.round(scored.reduce((s, e) => s + e.score, 0) / scored.length) : null;

  // Recommended: ACTIVE courses the employee is not enrolled in (heuristic), top 5.
  const enrolledCourseIds = enrollments.map((e) => e.courseId);
  const recommended = await prisma.trainingCourse.findMany({
    where: { status: "ACTIVE", id: { notIn: enrolledCourseIds.length ? enrolledCourseIds : [-1] } },
    orderBy: [{ createdAt: "desc" }],
    take: 5,
    select: { id: true, title: true, categoryId: true, durationHours: true, mode: true },
  });

  return {
    coursesDone: completed.length,
    coursesEnrolled: enrollments.length,
    avgScore, // null if no scored completions
    certificates: { count: certifications.length, items: certifications.slice(0, 10) },
    activeLearningPaths: learningPaths.map((lp) => ({ id: lp.id, name: lp.learningPath?.name ?? null, targetRole: lp.learningPath?.targetRole ?? null, progress: num(lp.progress), status: lp.status })),
    recommended: recommended.map((c) => ({ id: c.id, title: c.title, durationHours: c.durationHours, mode: c.mode })),
    activityTimeline: recentLogs.map((l) => ({ id: l.id, timestamp: l.created_at, action: l.action_type || l.type, module: l.module, result: l.result, notes: l.notes })),
  };
}

// -------------------------------------------------------------- activity ----
async function activityTab(id, tenantId, ctx) {
  // Entirely RBAC-owned; fail-soft until cross-service auth (JWT-alignment) lands.
  const activity = await getEmployeeActivity(id);
  return activity;
}

/**
 * Fetch ONE tab of the employee profile + the always-on header.
 *
 * @param {string|number} employeeId
 * @param {string|null}   tenantId
 * @param {object} opts
 * @param {string}  [opts.tab="overview"]
 * @param {boolean} [opts.showSensitive=false]
 * @param {string}  [opts.taxFiscalYear]
 */
export async function getEmployeeProfileTab(employeeId, tenantId, opts = {}) {
  const id = Number(employeeId);
  if (!Number.isFinite(id)) throw Object.assign(new Error("Invalid employee ID"), { status: 400 });
  const tab = PROFILE_TABS.includes(opts.tab) ? opts.tab : "overview";

  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id }),
    select: {
      id: true, employee_code: true, first_name: true, middle_name: true, last_name: true,
      employee_name: true, job_title: true, photo_url: true, status: true, employement_status: true,
      managerId: true, gradeLevel: { select: { name: true } }, Position: { select: { title: true } },
    },
  });
  if (!employee) throw Object.assign(new Error("Employee not found"), { status: 404 });

  // Resolve org (company/dept) + linked userId once; reused by header + projects/activity.
  const org = await getUserByEmployeeId(id);
  const userId = org?.raw?.id ?? org?.raw?.userId ?? null;
  const ctx = { showSensitive: Boolean(opts.showSensitive), taxFiscalYear: opts.taxFiscalYear, org, userId };

  let data;
  switch (tab) {
    case "job_and_comp": data = await jobCompTab(id, tenantId, ctx); break;
    case "performance": data = await performanceTab(id, tenantId); break;
    case "leaves": data = await leavesTab(id, tenantId, employee); break;
    case "training": data = await trainingTab(id, tenantId); break;
    case "activity": data = await activityTab(id, tenantId, ctx); break;
    case "overview":
    default: data = await overviewTab(id, tenantId, ctx); break;
  }

  logger.debug({ employeeId: id, tenantId, tab, showSensitive: ctx.showSensitive }, "hr: getEmployeeProfileTab");
  return { employeeId: id, tab, header: await buildHeader(employee, org), data };
}
