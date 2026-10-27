import { z } from "zod";
import { EmployeeCode } from "@trusoft/contracts/assessment";
import {
  run,
  config,
  json,
  fail,
  identity,
  hash,
  currentProfile,
} from "./base.js";
import { loadAttendanceRuntime } from "../../lib/attendanceRuntime.js";
import { parseCaptureTimestamp } from "../../lib/attendanceCapture.js";
import { dateRange } from "../../lib/attendanceDates.js";
import { equivalentCapabilities } from "./equivalence.js";
export const PlanningQuery = z
  .object({
    employeeCodes: z.array(EmployeeCode).max(100),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    referencesOnly: z.boolean().default(false),
  })
  .strict();
export async function planningSnapshot(raw) {
  const input = PlanningQuery.parse(raw);
  if (
    !Number.isFinite(Date.parse(input.from)) ||
    !Number.isFinite(Date.parse(input.to)) ||
    input.from > input.to ||
    Date.parse(input.to) - Date.parse(input.from) > 90 * 86400000
  )
    fail("PLANNING_WINDOW", "Planning window is limited to 90 days");
  return run("hr.capability.read", (tx, env) =>
    planningSnapshotFor(tx, env, input),
  );
}
export async function planningSnapshotFor(tx, env, input) {
  if (input.referencesOnly) {
    const employees = await tx.assessmentIdentity.findMany({
      where: { tenantId: env.tenantId, active: true },
      select: { employeeCode: true },
      orderBy: { employeeCode: "asc" },
      take: 2000,
    });
    const tasks = await tx.assessmentTaskVersion.findMany({
      where: { tenantId: env.tenantId, status: "PUBLISHED" },
      select: { taskCode: true, taskVersion: true, definition: true },
      take: 2000,
    });
    return {
      companyUuid: env.tenantId,
      actorCode: env.who.employeeCode,
      employees,
      tasks: tasks.map((t) => ({
        taskCode: t.taskCode,
        taskVersion: t.taskVersion,
        title: t.definition.title,
        scopeKey: `${t.definition.complexity}|${t.definition.technology}|${t.definition.scope}`,
        complexity: t.definition.complexity,
        technology: t.definition.technology,
        unit: t.definition.benchmarkPolicy?.unit,
        applicability: t.definition.applicability,
      })),
    };
  }
  if (!input.employeeCodes.length)
    fail("EMPLOYEE_REQUIRED", "Select at least one employee code");
  const cfg = await config(tx, env.tenantId),
    runtime = await loadAttendanceRuntime({
      tenantId: env.tenantId,
      from: input.from,
      to: input.to,
      db: tx,
    });
  const exceptions = await tx.assessmentException.findMany({
    where: {
      tenantId: env.tenantId,
      kind: "CIRCUIT_BREAKER",
      status: "OPEN",
    },
    select: { key: true },
  });
  const employees = [];
  for (const employeeCode of input.employeeCodes) {
    const person = await identity(tx, env.tenantId, employeeCode);
    const exit = await tx.separation.findFirst({where:{tenantId:env.tenantId,employeeCode,approvedAt:{not:null},state:{notIn:['WITHDRAWN','CANCELLED']}},orderBy:{lastWorkingAt:'asc'}});
    const profile = await currentProfile(tx, env, person);
    const training = await tx.trainingSessionAttendee.findMany({
      where: { tenantId: env.tenantId, employeeId: person.employeeRowId },
      include: { session: true },
    });
    const trainingIntervals = training
      .filter((a) => a.session.scheduledAt && a.session.durationMinutes > 0)
      .map((a) => ({
        start: +a.session.scheduledAt,
        end: +a.session.scheduledAt + a.session.durationMinutes * 60000,
      }));
    const credentials = await tx.certification.findMany({
      where: {
        tenantId: env.tenantId,
        employeeId: person.employeeRowId,
        status: "ACTIVE",
        OR: [
          { expiryDate: null },
          { expiryDate: { gt: new Date(input.to + "T23:59:59Z") } },
        ],
      },
      select: { credentialId: true },
    });
    const employee = await tx.employee.findFirst({
      where: { tenant_id: env.tenantId, id: person.employeeRowId },
      select: { fte: true },
    });
    const intervals = [],
      calendarIssues = [];
    for (const date of dateRange(input.from, input.to, 92)) {
      const info = runtime.resolve(person.employeeRowId, date);
      if (info.working === null) {
        calendarIssues.push({ date, reason: info.reason });
        continue;
      }
      if (!info.working || !info.shift?.start || !info.shift?.end) continue;
      const instant = (d) =>
        parseCaptureTimestamp(
          new Date(d).toISOString().slice(0, 19),
          info.timeZone,
        ).occurredAt;
      let pieces = [[+instant(info.shift.start), +instant(info.shift.end)]];
      for (const exclusion of info.shift.exclusions || []) {
        const x = +instant(exclusion.start),
          y = +instant(exclusion.end);
        pieces = pieces.flatMap(([s, e]) =>
          y <= s || x >= e
            ? [[s, e]]
            : [
                [s, Math.min(x, e)],
                [Math.max(s, y), e],
              ].filter(([s, e]) => e > s),
        );
      }
      for (const { start: x, end: y } of trainingIntervals)
        pieces = pieces.flatMap(([s, e]) =>
          y <= s || x >= e
            ? [[s, e]]
            : [
                [s, Math.min(x, e)],
                [Math.max(s, y), e],
              ].filter(([s, e]) => e > s),
        );
      if(exit?.lastWorkingAt)pieces=pieces.map(([s,e])=>[s,Math.min(e,+exit.lastWorkingAt)]).filter(([s,e])=>e>s);
      for (const [s, e] of pieces) {
        const end =
          s +
          Math.floor(
            ((e - s) / 60000) * Math.min(1, Math.max(0, employee.fte ?? 1)),
          ) *
            60000;
        if (end > s)
          intervals.push({
            start: new Date(s).toISOString(),
            end: new Date(end).toISOString(),
            site: info.siteAssignment?.siteCode || null,
          });
      }
    }
    const capabilities = await tx.assessmentCapability.findMany({
      where: { tenantId: env.tenantId, employeeCode },
    });
    const restrictions = await tx.assessmentRestriction.findMany({
      where: { tenantId: env.tenantId, employeeCode, liftedAt: null },
    });
    const timing = await tx.assessmentTimingSample.findMany({
      where: {
        tenantId: env.tenantId,
        employeeCode,
        accepted: true,
        comparable: true,
        withdrawnAt: null,
        capturedAt: { gte: new Date(env.now.getTime() - 365 * 86400000) },
      },
      take: 1000,
      orderBy: { capturedAt: "desc" },
    });
    employees.push({
      employeeCode,
      active: person.active,
      capabilities: (
        await equivalentCapabilities(tx, env.tenantId, capabilities)
      )
        .filter((c) =>
          profile.definition.requirements.some(
            (r) => r.taskCode === c.taskCode && r.taskVersion === c.taskVersion,
          ),
        )
        .map(({ id, tenantId, ...c }) => c),
      restrictions: restrictions.map(({ id, tenantId, ...r }) => r),
      intervals,
      calendarIssues,
      prerequisites: credentials.map((c) => c.credentialId).filter(Boolean),
      timingSamples: timing.map((t) => ({
        taskCode: t.taskCode,
        taskVersion: t.taskVersion,
        caseRef: t.caseRef,
        clockBasis: t.clockBasis,
        unit: t.unit,
        context: t.context,
        complexity: t.complexity,
        technology: t.technology,
        attributableMinutes: String(t.attributableMinutes),
        acceptedUnits: String(t.acceptedUnits),
      })),
    });
  }
  const payload = json({
    companyUuid: env.tenantId,
    actorCode: env.who.employeeCode,
    asOf: env.now,
    stage: cfg.policy.stage,
    exceptions: exceptions.map((e) => e.key),
    employees,
  });
  return { ...payload, digest: hash(payload) };
}
