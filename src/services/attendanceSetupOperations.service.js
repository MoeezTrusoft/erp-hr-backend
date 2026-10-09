import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import { writeRoster } from './workScheduleService.js';
import {
  badSetup,
  covers,
  dateKey,
  dateOnly,
  overlaps,
  addDays,
} from '../lib/attendanceDates.js';

export async function createSetupCalendar({ tenantId, name, year, actorId }) {
  if (!tenantId || !actorId)
    throw badSetup('A tenant and linked employee identity are required', 403);
  if (!name?.trim() || !Number.isInteger(year) || year < 1900 || year > 2200)
    throw badSetup('Calendar name and a valid year are required');
  return prisma.holidayCalendar.create({
    data: { tenantId, name: name.trim(), year, createdById: actorId },
  });
}

export async function bulkAssignRosters({
  tenantId,
  employeeIds,
  data,
  dryRun = true,
}) {
  const ids = [...new Set(employeeIds)];
  const results = [];
  // Deliberately bounded transactions: one invalid employee does not conceal
  // successful assignments; the response makes every outcome explicit.
  for (const employeeId of ids) {
    try {
      results.push({
        employeeId,
        success: true,
        result: await writeRoster({ tenantId, employeeId, data, dryRun }),
      });
    } catch (e) {
      results.push({ employeeId, success: false, error: e.message });
    }
  }
  return {
    dryRun,
    results,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
  };
}
export async function previewDeviceMapping({
  tenantId,
  deviceUserId,
  sn,
  date,
}) {
  const rows = await prisma.employeeDeviceEnrolment.findMany({
    where: { tenantId, deviceUserId },
    include: {
      employee: {
        select: { id: true, employee_code: true, employee_name: true },
      },
    },
  });
  const active = rows.filter((r) => covers(r, date) && (!r.sn || r.sn === sn));
  const exact = active.filter((r) => r.sn === sn && sn),
    candidates = exact.length ? exact : active;
  const ids = [...new Set(candidates.map((r) => r.employeeId))];
  return {
    date: dateKey(date),
    deviceUserId,
    sn: sn || null,
    status: ids.length === 1 ? 'READY' : ids.length ? 'CONFLICT' : 'INCOMPLETE',
    matches: candidates.map((r) => ({
      employee: r.employee,
      enrolmentId: r.id,
      primary: r.isPrimary,
    })),
  };
}
export async function rolloverHolidayCalendar({
  tenantId,
  calendarId,
  year,
  dryRun = true,
  actorId,
}) {
  return tenantTransaction(
    prisma,
    async (tx) => {
      const calendar = await tx.holidayCalendar.findFirst({
        where: { id: calendarId, tenantId },
      });
      if (!calendar) throw badSetup('Calendar not found', 404);
      const holidays = await tx.holiday.findMany({
        where: { holidayCalendarId: calendarId, tenantId },
        orderBy: { date: 'asc' },
      });
      const proposed = holidays.map((h) => ({
        name: h.name,
        description: h.description,
        fullDay: h.fullDay,
        startTime: h.startTime,
        endTime: h.endTime,
        date: `${year}${dateKey(h.date).slice(4)}`,
      }));
      for (const h of proposed) dateKey(h.date); // Feb 29 requires an explicit choice, never silently March 1.
      const targetName = `${calendar.name.replace(/\s(?:19|20|21)\d{2}$/, '')} ${year}`;
      const existing = await tx.holidayCalendar.findFirst({
        where: { tenantId, name: targetName },
      });
      if (existing)
        throw badSetup(
          'This annual calendar already exists; review it instead',
          409,
        );
      if (dryRun)
        return { calendar: { ...calendar, year }, holidays: proposed, dryRun };
      if (!actorId)
        throw badSetup(
          'A linked employee identity is required to create a calendar',
        );
      const created = await tx.holidayCalendar.create({
        data: {
          tenantId,
          regionId: calendar.regionId,
          name: targetName,
          description: calendar.description,
          year,
          createdById: actorId,
        },
      });
      await tx.holiday.createMany({
        data: proposed.map((h) => ({
          ...h,
          date: new Date(`${h.date}T00:00:00Z`),
          tenantId,
          holidayCalendarId: created.id,
          createdById: actorId,
        })),
      });
      return { calendar: created, holidays: proposed, dryRun };
    },
    { tenantId, txOptions: { isolationLevel: 'Serializable' } },
  );
}

export async function importSetupHolidays({
  tenantId,
  calendarId,
  holidays,
  dryRun = true,
  actorId,
}) {
  if (!Array.isArray(holidays) || !holidays.length || holidays.length > 500)
    throw badSetup('Import 1–500 holidays at a time');
  return tenantTransaction(
    prisma,
    async (tx) => {
      const calendar = await tx.holidayCalendar.findFirst({
        where: { tenantId, id: calendarId },
      });
      if (!calendar) throw badSetup('Calendar not found', 404);
      const existing = await tx.holiday.findMany({
        where: { tenantId, holidayCalendarId: calendarId },
        select: { date: true },
      });
      const seen = new Set(existing.map((h) => dateKey(h.date))),
        errors = [];
      const rows = holidays
        .map((h, i) => {
          try {
            const date = dateKey(h.date),
              name = String(h.name || '').trim();
            if (!name) throw badSetup('Name is required');
            if (calendar.year && Number(date.slice(0, 4)) !== calendar.year)
              throw badSetup('Date is outside the calendar year');
            if (seen.has(date)) throw badSetup('Duplicate holiday date');
            seen.add(date);
            const fullDay = h.fullDay !== false;
            if (
              !fullDay &&
              (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.startTime) ||
                !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.endTime) ||
                h.startTime >= h.endTime)
            )
              throw badSetup(
                'Partial holidays require ordered start and end times',
              );
            return {
              name,
              date,
              description: String(h.description || ''),
              fullDay,
              startTime: fullDay ? null : h.startTime,
              endTime: fullDay ? null : h.endTime,
            };
          } catch (e) {
            errors.push({ row: i + 1, message: e.message });
            return null;
          }
        })
        .filter(Boolean);
      if (dryRun) return { rows, errors, ready: !errors.length };
      if (errors.length)
        throw Object.assign(badSetup('Correct the holiday import errors'), {
          errors,
        });
      if (!actorId)
        throw badSetup(
          'A linked employee identity is required to import holidays',
        );
      await tx.holiday.createMany({
        data: rows.map((h) => ({
          ...h,
          date: dateOnly(h.date),
          tenantId,
          holidayCalendarId: calendarId,
          createdById: actorId,
        })),
      });
      return { created: rows.length };
    },
    { tenantId, txOptions: { isolationLevel: 'Serializable' } },
  );
}

export async function assignSetupCalendar({
  tenantId,
  employeeId,
  calendarId,
  from,
  to,
}) {
  const effectiveFrom = dateOnly(from),
    effectiveTo = to ? dateOnly(to) : null;
  if (effectiveTo && effectiveTo < effectiveFrom)
    throw badSetup('Calendar assignment end precedes its start');
  return tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:calendar:${employeeId}`}))`;
      if (
        !(await tx.employee.findFirst({
          where: { tenant_id: tenantId, id: employeeId },
        })) ||
        !(await tx.holidayCalendar.findFirst({
          where: { tenantId, id: calendarId },
        }))
      )
        throw badSetup('Employee or calendar not found in tenant', 404);
      const rows = await tx.employeeHolidayCalendar.findMany({
        where: { tenantId, employeeId },
      });
      const hits = rows.filter((r) =>
        overlaps(r, { effectiveFrom, effectiveTo }),
      );
      if (
        hits.some(
          (r) => r.effectiveTo || dateKey(r.effectiveFrom) >= dateKey(from),
        )
      )
        throw badSetup(
          'Calendar assignment conflicts with an existing period',
          409,
        );
      for (const row of hits)
        await tx.employeeHolidayCalendar.update({
          where: {
            employeeId_holidayCalendarId_effectiveFrom: {
              employeeId,
              holidayCalendarId: row.holidayCalendarId,
              effectiveFrom: row.effectiveFrom,
            },
          },
          data: { effectiveTo: addDays(from, -1) },
        });
      return tx.employeeHolidayCalendar.create({
        data: {
          tenantId,
          employeeId,
          holidayCalendarId: calendarId,
          effectiveFrom,
          effectiveTo,
        },
      });
    },
    { tenantId, txOptions: { isolationLevel: 'Serializable' } },
  );
}
