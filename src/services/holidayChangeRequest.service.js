// Holiday changes and holiday exemptions by approval (HOLIDAY_CHANGE, HOLIDAY_EXEMPTION).
// HR files the request; the company's published ATTENDANCE route approves it; the holiday rows are written only on the
// final approval, for past, present and future days alike, and the affected employees' days are re-queued for
// attendance evaluation in the same transaction (past and present days now; future days are planned when they arrive).
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { badSetup, dateKey, dateOnly } from '../lib/attendanceDates.js';
import { validateHolidayWindow } from '../lib/attendanceSetup.js';
import { todayInZone } from '../lib/holidayDates.js';
import { legacySubmit } from './approval/legacy.js';
import { assertRosterPeriodEditable } from './workScheduleService.js';
import { enqueueEvaluationRange } from './attendanceFinalization.service.js';
import { emitHolidayChanged } from './hrConfigEvents.js';

const MAX_ITEMS = 500;
const MAX_EXEMPT = 500;

const actorOf = (requestedById) => {
  const actor = Number(requestedById);
  if (!Number.isInteger(actor) || actor < 1)
    throw badSetup('Sign in with an employee account to request a holiday change', 403);
  return actor;
};
const reasonOf = (reason) => {
  const text = String(reason ?? '').trim();
  if (text.length < 3) throw badSetup('Give a reason (at least 3 characters)');
  return text.slice(0, 1000);
};

// A holiday as stored, from loose input; throws a plain sentence when it is not usable.
function cleanItem(input, calendar) {
  const name = String(input.name ?? '').trim();
  if (!name) throw badSetup('Every holiday needs a name');
  const date = dateKey(input.date);
  if (calendar.year && Number(date.slice(0, 4)) !== calendar.year)
    throw badSetup(`${name} (${date}) is outside the calendar year ${calendar.year}`);
  const fullDay = input.fullDay !== false;
  const item = {
    date,
    name,
    description: String(input.description ?? ''),
    fullDay,
    startTime: fullDay ? null : input.startTime,
    endTime: fullDay ? null : input.endTime,
  };
  validateHolidayWindow(item);
  return item;
}

async function lockAndLoadCalendar(tx, tenantId, holidayCalendarId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:holiday-calendar:${holidayCalendarId}`}))`;
  const calendar = await tx.holidayCalendar.findFirst({ where: { id: Number(holidayCalendarId), tenantId } });
  if (!calendar) throw badSetup('Holiday calendar not found', 404);
  return calendar;
}

// What the change would do to the calendar right now. Used when filing and again at the final approval.
async function planChange(tx, tenantId, { action, holidayCalendarId, holidayId, payload }) {
  const calendar = await lockAndLoadCalendar(tx, tenantId, holidayCalendarId);
  const existing = await tx.holiday.findMany({ where: { tenantId, holidayCalendarId: calendar.id } });
  const taken = new Map(existing.map((h) => [dateKey(h.date), h]));
  if (action === 'CREATE') {
    const items = (payload.holidays ?? []).map((h) => cleanItem(h, calendar));
    if (!items.length || items.length > MAX_ITEMS) throw badSetup(`Add between 1 and ${MAX_ITEMS} holidays at a time`);
    const seen = new Set();
    for (const item of items) {
      if (taken.has(item.date) || seen.has(item.date))
        throw badSetup(`There is already a holiday on ${item.date} in this calendar`, 409);
      seen.add(item.date);
    }
    return { calendar, items, dates: items.map((i) => i.date) };
  }
  const current = existing.find((h) => h.id === Number(holidayId));
  if (!current) throw badSetup('Holiday not found in this calendar', 404);
  if (action === 'DELETE') return { calendar, current, dates: [dateKey(current.date)] };
  const changes = payload.changes ?? {};
  const next = cleanItem({ ...current, ...changes, date: changes.date ?? current.date }, calendar);
  const clash = taken.get(next.date);
  if (clash && clash.id !== current.id) throw badSetup(`There is already a holiday on ${next.date} in this calendar`, 409);
  return { calendar, current, next, dates: [...new Set([dateKey(current.date), next.date])] };
}

async function submitOrDrop(table, kind, row, reason) {
  try {
    await legacySubmit(kind, row.id, reason, { onBehalf: true });
  } catch (error) {
    await prisma[table].deleteMany({ where: { id: row.id, tenantId: row.tenantId, status: 'PENDING' } });
    throw error;
  }
}

const sent = (row, extra = {}) => ({
  pendingApproval: true,
  requestId: row.id,
  status: 'PENDING',
  message: 'Sent for approval. The calendar changes when the approval route approves it.',
  ...extra,
});

/** File a holiday add (one or many), change or removal. `holidays` is the list for CREATE; `changes` for UPDATE. */
export async function requestHolidayChange({ tenantId, requestedById, action, holidayCalendarId, holidayId, holidays, changes, reason }) {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  if (!['CREATE', 'UPDATE', 'DELETE'].includes(action)) throw badSetup('Unknown holiday action');
  const actor = actorOf(requestedById);
  const why = reasonOf(reason);
  const row = await tenantTransaction(
    prisma,
    async (tx) => {
      const plan = await planChange(tx, tenantId, {
        action, holidayCalendarId, holidayId, payload: { holidays, changes },
      });
      await assertRosterPeriodEditable(tx, tenantId, plan.dates.slice().sort()[0], plan.dates.slice().sort().at(-1));
      // One waiting request per day: a second one for the same date could only fail at the last approval level.
      const waiting = await tx.holidayChangeRequest.findMany({ where: { tenantId, holidayCalendarId: plan.calendar.id, status: 'PENDING' } });
      const claimed = new Set(waiting.flatMap((w) => [
        ...(w.payload.holidays ?? []).map((h) => h.date), w.payload.date, w.payload.changes?.date].filter(Boolean)));
      const clash = plan.dates.find((d) => claimed.has(d));
      if (clash) throw badSetup(`There is already a pending holiday request for ${clash}`, 409);
      const payload =
        action === 'CREATE'
          ? { holidays: plan.items }
          : action === 'DELETE'
            ? { date: dateKey(plan.current.date), name: plan.current.name }
            : { date: dateKey(plan.current.date), name: plan.current.name, changes: plan.next };
      return tx.holidayChangeRequest.create({
        data: { id: randomUUID(), tenantId, action, holidayId: action === 'CREATE' ? null : Number(holidayId),
          holidayCalendarId: plan.calendar.id, payload, reason: why, requestedById: actor },
      });
    },
    { tenantId },
  );
  await submitOrDrop('holidayChangeRequest', 'HOLIDAY_CHANGE', row, why);
  return sent(row, { action });
}

// Re-queue the affected days. Days after today are not evaluated yet; the daily planner picks them up.
async function requeue(tx, tenantId, dates, employeeIds) {
  const today = dateKey(todayInZone());
  const past = [...new Set(dates)].filter((d) => d <= today);
  if (!past.length || !employeeIds.length) return { days: 0, employees: employeeIds.length };
  for (const day of past) await enqueueEvaluationRange({ tenantId, from: day, to: day, employeeIds }, tx);
  await tx.attendanceEvaluationJob.updateMany({
    where: { tenantId, employeeId: { in: employeeIds }, date: { in: past.map(dateOnly) } },
    data: { state: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null, completedAt: null },
  });
  return { days: past.length, employees: employeeIds.length };
}

const audit = (tx, tenantId, action, details, newValues) =>
  tx.payrollAuditLog.create({ data: { tenantId, action, details, oldValues: null, newValues } });

export async function finalizeHolidayChange(tx, env, row, approved) {
  const tenantId = env.tenantId;
  if (approved) {
    const plan = await planChange(tx, tenantId, {
      action: row.action, holidayCalendarId: row.holidayCalendarId, holidayId: row.holidayId, payload: row.payload,
    });
    const sorted = plan.dates.slice().sort();
    await assertRosterPeriodEditable(tx, tenantId, sorted[0], sorted.at(-1));
    if (row.action === 'DELETE') {
      const waiting = await tx.holidayExemptionRequest.count({ where: { tenantId, holidayId: row.holidayId, status: 'PENDING' } });
      if (waiting) throw badSetup('Decide the pending exemption requests for this holiday first', 409);
      await tx.holiday.delete({ where: { id: row.holidayId } });
    } else if (row.action === 'UPDATE') {
      await tx.holiday.update({
        where: { id: row.holidayId },
        data: { name: plan.next.name, description: plan.next.description, fullDay: plan.next.fullDay,
          startTime: plan.next.startTime, endTime: plan.next.endTime, date: dateOnly(plan.next.date), updatedById: row.requestedById },
      });
    } else {
      await tx.holiday.createMany({
        data: plan.items.map((h) => ({ ...h, date: dateOnly(h.date), tenantId, holidayCalendarId: plan.calendar.id, createdById: row.requestedById })),
      });
    }
    const people = await tx.employee.findMany({ where: { tenant_id: tenantId }, select: { id: true } });
    const queued = await requeue(tx, tenantId, plan.dates, people.map((p) => p.id));
    await audit(tx, tenantId, 'HOLIDAY_CHANGE_APPLIED',
      `Holiday ${row.action.toLowerCase()} applied to calendar #${plan.calendar.id}: ${row.reason}`,
      { requestId: row.id, action: row.action, dates: plan.dates, reevaluated: queued });
    for (const date of plan.dates)
      emitHolidayChanged({ tenantId, actorId: env.ctx?.user?.userId, calendarId: plan.calendar.id, date,
        action: { CREATE: 'created', UPDATE: 'updated', DELETE: 'deleted' }[row.action] })?.catch?.(() => {});
  }
  await tx.holidayChangeRequest.update({ where: { id: row.id }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
}

/** File an exemption (or its removal) for named employees on one holiday. The caller has already checked the grant. */
export async function requestHolidayExemption({ tenantId, requestedById, holidayId, employeeIds, mode = 'EXEMPT', reason }) {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  if (!['EXEMPT', 'RESTORE'].includes(mode)) throw badSetup('Unknown exemption mode');
  const actor = actorOf(requestedById);
  const why = reasonOf(reason);
  const ids = [...new Set((employeeIds ?? []).map(Number))];
  if (!ids.length || ids.length > MAX_EXEMPT || ids.some((n) => !Number.isInteger(n) || n < 1))
    throw badSetup(`Choose between 1 and ${MAX_EXEMPT} employees`);
  const row = await tenantTransaction(
    prisma,
    async (tx) => {
      const holiday = await tx.holiday.findFirst({ where: { id: Number(holidayId), tenantId } });
      if (!holiday) throw badSetup('Holiday not found', 404);
      await assertRosterPeriodEditable(tx, tenantId, holiday.date, holiday.date);
      const people = await tx.employee.findMany({ where: { tenant_id: tenantId, id: { in: ids } }, select: { id: true } });
      if (people.length !== ids.length) throw badSetup('Every selected employee must belong to this company');
      const current = await tx.holidayExemption.findMany({ where: { tenantId, holidayId: holiday.id, employeeId: { in: ids } } });
      if (mode === 'EXEMPT' && current.length) throw badSetup('Some of these employees are already exempt from this holiday', 409);
      if (mode === 'RESTORE' && current.length !== ids.length) throw badSetup('Only employees who are exempt can be restored to the holiday', 409);
      // Approvers read names, not ids: the request carries who and which holiday as text.
      const named = await tx.employee.findMany({ where: { tenant_id: tenantId, id: { in: ids } },
        select: { employee_code: true, employee_name: true, first_name: true, last_name: true } });
      const summary = {
        holiday: { name: holiday.name, date: dateKey(holiday.date) },
        employees: named.map((p) => ({ code: p.employee_code,
          name: p.employee_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.employee_code })),
      };
      return tx.holidayExemptionRequest.create({
        data: { id: randomUUID(), tenantId, mode, holidayId: holiday.id, employeeIds: ids, summary, reason: why, requestedById: actor },
      });
    },
    { tenantId },
  );
  await submitOrDrop('holidayExemptionRequest', 'HOLIDAY_EXEMPTION', row, why);
  return sent(row, { mode, employees: ids.length });
}

export async function finalizeHolidayExemption(tx, env, row, approved) {
  const tenantId = env.tenantId;
  if (approved) {
    const holiday = await tx.holiday.findFirst({ where: { id: row.holidayId, tenantId } });
    if (!holiday) throw badSetup('Holiday no longer exists', 409);
    await assertRosterPeriodEditable(tx, tenantId, holiday.date, holiday.date);
    if (row.mode === 'EXEMPT')
      await tx.holidayExemption.createMany({
        data: row.employeeIds.map((employeeId) => ({ tenantId, holidayId: holiday.id, employeeId, requestId: row.id })),
        skipDuplicates: true,
      });
    else await tx.holidayExemption.deleteMany({ where: { tenantId, holidayId: holiday.id, employeeId: { in: row.employeeIds } } });
    const queued = await requeue(tx, tenantId, [dateKey(holiday.date)], row.employeeIds);
    await audit(tx, tenantId, 'HOLIDAY_EXEMPTION_APPLIED',
      `Holiday #${holiday.id} ${row.mode === 'EXEMPT' ? 'exemption' : 'restore'} applied to ${row.employeeIds.length} employee(s): ${row.reason}`,
      { requestId: row.id, mode: row.mode, holidayId: holiday.id, employeeIds: row.employeeIds, reevaluated: queued });
  }
  await tx.holidayExemptionRequest.update({ where: { id: row.id }, data: { status: approved ? 'APPROVED' : 'REJECTED' } });
}

/** Who is exempt from a holiday, for the holiday's detail panel. */
export async function listHolidayExemptions({ tenantId, holidayId }) {
  const rows = await prisma.holidayExemption.findMany({
    where: { tenantId, holidayId: Number(holidayId) },
    orderBy: { id: 'asc' },
  });
  const people = await prisma.employee.findMany({
    where: { tenant_id: tenantId, id: { in: rows.map((r) => r.employeeId) } },
    select: { id: true, employee_code: true, employee_name: true, first_name: true, last_name: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  return rows.map((r) => {
    const p = byId.get(r.employeeId);
    return { employeeId: r.employeeId, code: p?.employee_code ?? null,
      name: p?.employee_name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || null, since: r.createdAt };
  });
}

const codes = async (tenantId, ids) => {
  const people = await prisma.employee.findMany({ where: { tenant_id: tenantId, id: { in: [...new Set(ids)] } }, select: { id: true, employee_code: true } });
  return new Map(people.map((p) => [p.id, p.employee_code]));
};
// Screens show a person's name; the code stays beside it for compatibility.
const personNames = async (tenantId, ids) => {
  const people = await prisma.employee.findMany({ where: { tenant_id: tenantId, id: { in: [...new Set(ids)] } }, select: { id: true, employee_name: true, first_name: true, last_name: true } });
  return new Map(people.map((p) => [p.id, p.employee_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || null]));
};

/** Holiday changes and exemptions still waiting for the route, so the calendar screen can show them. */
export async function listPendingHolidayRequests({ tenantId, holidayCalendarId }) {
  const [changes, exemptions] = await Promise.all([
    prisma.holidayChangeRequest.findMany({ where: { tenantId, status: 'PENDING', ...(holidayCalendarId ? { holidayCalendarId: Number(holidayCalendarId) } : {}) }, orderBy: { createdAt: 'asc' } }),
    prisma.holidayExemptionRequest.findMany({ where: { tenantId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } }),
  ]);
  const askers = [...changes, ...exemptions].map((r) => r.requestedById);
  const who = await codes(tenantId, askers);
  const whoName = await personNames(tenantId, askers);
  return [
    ...changes.map((r) => ({ kind: 'HOLIDAY_CHANGE', id: r.id, action: r.action, summary: r.payload, reason: r.reason,
      requestedBy: who.get(r.requestedById) ?? null, requestedByName: whoName.get(r.requestedById) ?? null, createdAt: r.createdAt })),
    ...exemptions.map((r) => ({ kind: 'HOLIDAY_EXEMPTION', id: r.id, mode: r.mode, holidayId: r.holidayId, employees: r.employeeIds.length,
      reason: r.reason, requestedBy: who.get(r.requestedById) ?? null, requestedByName: whoName.get(r.requestedById) ?? null, createdAt: r.createdAt })),
  ];
}
