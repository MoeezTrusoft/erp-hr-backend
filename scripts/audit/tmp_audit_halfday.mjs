import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
import { resolveShiftStartMin, minutesOfDay } from '../src/lib/attendanceStatus.js';

const KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

await mcpCtx.run({ system: true }, async () => {
  const rows = await prisma.attendance.findMany({
    where: { status: 'HALF_DAY', date: { gte: new Date('2026-08-01T00:00:00Z'), lt: new Date('2026-09-12T00:00:00Z') } },
    select: { id: true, tenantId: true, employeeId: true, date: true, check_in: true, day_credit: true, remarks: true },
    orderBy: [{ date: 'asc' }],
  });
  console.log(`HALF_DAY rows Aug 1 – Sep 11: ${rows.length}`);

  const empIds = [...new Set(rows.map((r) => r.employeeId))];
  const schedules = await prisma.workSchedule.findMany({
    where: { employeeId: { in: empIds } },
    select: { employeeId: true, schedule_pattern: true, effective_start_date: true, effective_end_date: true },
  });
  const schedByEmp = new Map();
  for (const s of schedules) {
    const list = schedByEmp.get(s.employeeId) || [];
    list.push(s);
    schedByEmp.set(s.employeeId, list);
  }

  for (const r of rows) {
    const d = r.date;
    const key = KEYS[d.getUTCDay()];
    const scheds = (schedByEmp.get(r.employeeId) || []).filter(
      (s) => s.effective_start_date <= d && (!s.effective_end_date || s.effective_end_date >= d),
    );
    const pattern = scheds[0]?.schedule_pattern || null;
    const shiftStartMin = resolveShiftStartMin({ schedulePattern: pattern, date: d });
    const inMin = r.check_in ? minutesOfDay(r.check_in) : null;
    let lateness = null;
    if (inMin != null) {
      lateness = inMin - shiftStartMin;
      if (lateness > 12 * 60) lateness -= 24 * 60; // night-crossing out punches misread as ins
    }
    const flag = lateness == null ? 'no-checkin' : lateness >= 180 ? '>=3h (correct)' : lateness >= 0 ? '<3h (should be LATE)' : 'early (recheck)';
    console.log(`#${r.id} t=${(r.tenantId || '').slice(0, 8)} emp=${r.employeeId} ${d.toISOString().slice(0, 10)} in=${r.check_in ? r.check_in.toISOString().slice(11, 16) : '-'} shift=${String(Math.floor(shiftStartMin / 60)).padStart(2, '0')}:${String(shiftStartMin % 60).padStart(2, '0')} late=${lateness ?? '-'}min credit=${r.day_credit} → ${flag} [${(r.remarks || '').slice(0, 30)}]`);
  }
});

await prisma.$disconnect();
