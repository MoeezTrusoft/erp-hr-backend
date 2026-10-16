import { validateCheckoutWindow } from "../lib/shiftCheckout.js";
import { scheduledShifts } from "../lib/attendanceShift.js";
import { assertSchedulePattern } from "../lib/schedulePattern.js";
import { dateKey, covers } from "../lib/attendanceDates.js";
import { mcpCtx } from "../lib/requestContext.js";

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
export async function queueChangedShift(tx, tenantId, employeeId, date, today) {
  if (dateKey(date) > today) return;
  const workDate = new Date(dateKey(date) + "T00:00:00Z"),
    now = new Date();
  await tx.attendanceEvaluationJob.upsert({
    where: {
      tenantId_employeeId_date: { tenantId, employeeId, date: workDate },
    },
    create: {
      tenantId,
      employeeId,
      date: workDate,
      state: "PENDING",
      nextAttemptAt: now,
    },
    update: {
      state: "PENDING",
      attempts: 0,
      nextAttemptAt: now,
      completedAt: null,
      lastError: null,
    },
  });
}
export async function validateShiftMapping(tx, tenantId, row) {
  validateCheckoutWindow(row);
  if (
    row.departmentId &&
    !(await tx.businessUnit.findFirst({
      where: { id: row.departmentId, tenantId },
    }))
  )
    fail("Department not found in this company");
  if (row.supervisorId) {
    if (!row.departmentId) fail("Choose the department for this supervisor");
    const supervisor = await tx.employee.findFirst({
      where: { id: row.supervisorId, tenant_id: tenantId, status: "Active" },
    });
    if (!supervisor) fail("Choose an active supervisor from this company");
  }
}

export async function shiftForEmployee(
  tx,
  tenantId,
  employee,
  window,
  templates,
) {
  if (!window) return null;
  if (!window.templateId && !(window.from ?? window.fromTime)) return null;
  const where = {
    tenantId,
    ...(window.templateId
      ? { id: Number(window.templateId) }
      : {
          departmentId: employee.businessUnitId ?? -1,
          fromTime: window.from ?? window.fromTime,
          toTime: window.to ?? window.toTime,
        }),
  };
  const matches = templates
    ? templates.filter(
        (t) =>
          t.tenantId === tenantId &&
          (window.templateId
            ? t.id === Number(window.templateId)
            : t.departmentId === employee.businessUnitId &&
              t.fromTime === where.fromTime &&
              t.toTime === where.toTime),
      )
    : await tx.shiftTemplate.findMany({ where });
  if (matches.length > 1)
    fail(
      "More than one shift matches this department and time; select a specific shift template",
    );
  const template = matches[0];
  if (window.templateId && !template)
    fail("Shift template not found in this company");
  if (
    template?.departmentId &&
    template.departmentId !== employee.businessUnitId
  )
    fail("Shift belongs to a different department");
  return template || null;
}

export async function bindRosterShifts(
  tx,
  tenantId,
  employee,
  pattern,
  templates,
) {
  const bind = async (window) => {
    if (!window) return window;
    const shift = await shiftForEmployee(
      tx,
      tenantId,
      employee,
      window,
      templates,
    );
    return shift
      ? {
          ...window,
          templateId: shift.id,
          from: shift.fromTime,
          to: shift.toTime,
          checkoutCutoffTime: shift.checkoutCutoffTime,
          checkoutCutoffDayOffset: shift.checkoutCutoffDayOffset,
        }
      : window;
  };
  return {
    ...pattern,
    ...(pattern.shift ? { shift: await bind(pattern.shift) } : {}),
    ...(pattern.shifts
      ? { shifts: await Promise.all(pattern.shifts.map(bind)) }
      : {}),
    ...(pattern.rotatingShifts
      ? { rotatingShifts: await Promise.all(pattern.rotatingShifts.map(bind)) }
      : {}),
    ...(pattern.shiftByDay
      ? {
          shiftByDay: Object.fromEntries(
            await Promise.all(
              Object.entries(pattern.shiftByDay).map(async ([day, w]) => [
                day,
                await bind(w),
              ]),
            ),
          ),
        }
      : {}),
  };
}

// Check version boundaries and dated overrides as well as each recurring pattern.
// Only this employee's scheduled starts constrain a cutoff.
export function validateEmployeeShiftSequence(schedules, assignments = []) {
  const days = new Set();
  const around = (value) => {
    if (!value) return;
    const date = new Date(dateKey(value) + "T00:00:00Z");
    for (let i = -8; i <= 8; i++)
      days.add(dateKey(new Date(+date + i * 86400000)));
  };
  for (const row of schedules) {
    assertSchedulePattern(row.schedule_pattern);
    around(row.effective_start_date);
    around(row.effective_end_date);
  }
  for (const row of assignments) around(row.date);
  const windows = [...days]
    .sort()
    .flatMap((key) => {
      const override = assignments.filter((a) => dateKey(a.date) === key);
      if (override.length > 1)
        fail("Conflicting shift assignments for " + key, 409);
      if (override[0]) {
        const a = override[0];
        if (a.status && a.status !== "on_shift") return [];
        // A work-mode-only override inherits the roster's hours.
        if (a.fromTime || a.toTime) {
          validateCheckoutWindow(a);
          return scheduledShifts(
            { shift: { ...a, from: a.fromTime, to: a.toTime } },
            new Date(key + "T00:00:00Z"),
          );
        }
      }
      const rows = schedules.filter((s) =>
        covers(s, key, "effective_start_date", "effective_end_date"),
      );
      return rows.length === 1
        ? scheduledShifts(
            rows[0].schedule_pattern,
            new Date(key + "T00:00:00Z"),
          )
        : [];
    })
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < windows.length; i++) {
    if (
      windows[i - 1].checkoutCutoff &&
      +windows[i - 1].checkoutCutoff > +windows[i].start - 3600000
    )
      fail(
        "Latest checkout must be at least one hour before the employee’s next scheduled shift (" +
          windows[i].start.toISOString() +
          ")",
      );
  }
}

export async function applyShiftSupervisor(
  tx,
  { tenantId, employee, window, actorId, effectiveDate, nowDate },
) {
  if (nowDate && dateKey(effectiveDate) > dateKey(nowDate)) return false;
  const shift = await shiftForEmployee(tx, tenantId, employee, window);
  if (!shift?.supervisorId || shift.supervisorId === employee.managerId)
    return false;
  if (shift.supervisorId === employee.id) return false; // a supervisor never reports to themselves
  const supervisor = await tx.employee.findFirst({
    where: { id: shift.supervisorId, tenant_id: tenantId, status: "Active" },
  });
  if (!supervisor)
    fail("Shift supervisor is no longer active; update the shift", 409);
  const seen = new Set([employee.id]);
  let manager = supervisor;
  while (manager) {
    if (seen.has(manager.id))
      fail("Shift supervisor would create a reporting cycle", 409);
    seen.add(manager.id);
    manager = manager.managerId
      ? await tx.employee.findFirst({
          where: { id: manager.managerId, tenant_id: tenantId },
        })
      : null;
  }
  const previous = employee.managerId
    ? await tx.employee.findFirst({
        where: { id: employee.managerId, tenant_id: tenantId },
      })
    : null;
  const result = await tx.employee.updateMany({
    where: {
      id: employee.id,
      tenant_id: tenantId,
      managerId: employee.managerId,
    },
    data: { managerId: supervisor.id, version: { increment: 1 } },
  });
  if (!result.count) fail("Reporting line changed concurrently; retry", 409);
  const actor = mcpCtx.getStore()?.user;
  await tx.attendanceRuleAudit.create({
    data: {
      tenantId,
      employeeId: employee.id,
      action: "SHIFT_SUPERVISOR_REASSIGNED",
      actorId: String(
        actorId || actor?.userId || actor?.id || "shift-scheduler",
      ),
      data: {
        employeeCode: employee.employee_code,
        previousSupervisorCode: previous?.employee_code || null,
        supervisorCode: supervisor.employee_code,
        shiftId: shift.id,
        departmentId: shift.departmentId,
        effectiveDate: dateKey(effectiveDate),
      },
    },
  });
  return true;
}

// Read-only impact used by roster preview and validated again at save time.
export async function previewShiftSupervisor(tx, tenantId, employee, window) {
  const shift = await shiftForEmployee(tx, tenantId, employee, window);
  const current = employee.managerId ? await tx.employee.findFirst({where:{id:employee.managerId,tenant_id:tenantId}}) : null;
  const base = { previousCode: current?.employee_code || null, supervisorCode: current?.employee_code || null, shift: shift?.name || null, cutoff: shift?.checkoutCutoffTime || null, cutoffDayOffset: shift?.checkoutCutoffDayOffset ?? null };
  if (!shift?.supervisorId) return {...base, result:'No reassignment configured'};
  if (shift.supervisorId === employee.id) return {...base, result:'No change: employee is the shift supervisor'};
  const supervisor = await tx.employee.findFirst({where:{id:shift.supervisorId,tenant_id:tenantId,status:'Active'}});
  if (!supervisor) fail('Shift supervisor is no longer active; update the shift',409);
  let manager = supervisor;
  const seen = new Set([employee.id]);
  while (manager) {
    if (seen.has(manager.id)) fail('Shift supervisor would create a reporting cycle',409);
    seen.add(manager.id);
    manager = manager.managerId ? await tx.employee.findFirst({where:{id:manager.managerId,tenant_id:tenantId}}) : null;
  }
  return {...base, supervisorCode:supervisor.employee_code, result:supervisor.id===employee.managerId ? 'No change' : 'Reassign on effective shift date'};
}

// Invoked by the existing attendance planner so future-dated moves take effect
// on the company's civil date, even if the employee has not punched yet.
export async function syncCurrentShiftSupervisors(
  tx,
  tenantId,
  today,
  { employeeIds, strict = true } = {},
) {
  const templates = await tx.shiftTemplate.findMany({
    where: { tenantId, supervisorId: { not: null } },
  });
  if (!templates.length) return [];
  const employees = await tx.employee.findMany({
    where: {
      tenant_id: tenantId,
      status: "Active",
      ...(employeeIds ? { id: { in: employeeIds } } : {}),
      businessUnitId: {
        in: [...new Set(templates.map((t) => t.departmentId).filter(Boolean))],
      },
    },
    orderBy: { id: "asc" },
  });
  const schedules = await tx.workSchedule.findMany({
    where: {
      tenantId,
      effective_start_date: { lte: new Date(today + "T00:00:00Z") },
    },
  });
  const assignments = await tx.shiftAssignment.findMany({
    where: { tenantId, date: new Date(today + "T00:00:00Z") },
    orderBy: { id: "desc" },
  });
  const failures = [];
  for (const employee of employees) {
    const assignment = assignments.find((a) => a.employeeId === employee.id);
    const roster = schedules.filter(
      (s) =>
        s.employeeId === employee.id &&
        covers(s, today, "effective_start_date", "effective_end_date"),
    );
    if (!assignment && roster.length !== 1) continue;
    const day = new Date(today + "T00:00:00Z");
    if (assignment?.status && assignment.status !== "on_shift") continue;
    const options = scheduledShifts(roster[0]?.schedule_pattern, day);
    const resolved =
      assignment?.templateId || assignment?.fromTime
        ? assignment
        : options.length === 1
          ? options[0]
          : null;
    if (!resolved) continue;
    const window =
      assignment?.templateId || assignment?.fromTime
        ? assignment
        : {
            templateId: resolved.templateId,
            from: resolved.start?.toISOString().slice(11, 16),
            to: resolved.end?.toISOString().slice(11, 16),
          };
    if (!window.templateId && !window.fromTime && !window.from) continue;
    try {
      if (tx.$executeRaw)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:roster:${employee.id}`}))`;
      await applyShiftSupervisor(tx, {
        tenantId,
        employee,
        window,
        effectiveDate: today,
        nowDate: today,
      });
    } catch (error) {
      if (strict || ![400, 409].includes(error.status)) throw error;
      failures.push({
        tenantId,
        employeeCode: employee.employee_code,
        error: error.message,
      });
    }
  }
  return failures;
}
