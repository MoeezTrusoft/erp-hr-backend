// Operator ruling 2026-09-11: ">3h late = HALF_DAY". The running writer buckets
// HALF_DAY at >=30 min (HR_HALF_DAY_MIN default), so August/September rows exist
// that are late <3h yet stored HALF_DAY (credit 0.5). For every row where the
// schedule shift is UNAMBIGUOUS (weekly / shiftByDay day shift, no midnight
// crossing) and lateness < 180 min, flip to LATE with credit 1.0. Night-shift
// rotating rows are left for the post-deploy device re-sync to re-derive.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
import { minutesOfDay } from '../src/lib/attendanceStatus.js';

const KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const NOTE = 'POLICY 2026-09-11: >3h late = HALF_DAY; this <3h late restored to LATE';

await mcpCtx.run({ system: true }, async () => {
  const rows = await prisma.attendance.findMany({
    where: { status: 'HALF_DAY', date: { gte: new Date('2026-08-01T00:00:00Z'), lt: new Date('2026-09-12T00:00:00Z') } },
    select: { id: true, employeeId: true, date: true, check_in: true, remarks: true },
  });

  const empIds = [...new Set(rows.map((r) => r.employeeId))];
  const schedules = await prisma.workSchedule.findMany({
    where: { employeeId: { in: empIds } },
    select: { employeeId: true, schedule_pattern: true, effective_start_date: true, effective_end_date: true },
  });

  let flipped = 0, kept = 0;
  for (const r of rows) {
    const d = r.date;
    const scheds = schedules.filter(
      (s) => s.employeeId === r.employeeId && s.effective_start_date <= d && (!s.effective_end_date || s.effective_end_date >= d),
    );
    const pattern = scheds[0]?.schedule_pattern;
    if (!pattern || pattern.type !== 'weekly' || pattern.crossesMidnight) { kept++; continue; }

    // shift for the day: shiftByDay override else base shift.from
    const dayKey = KEYS[d.getUTCDay()];
    const over = pattern.shiftByDay?.[String(((d.getUTCDay() + 6) % 7) + 1)]; // ISO 1..7 key variant
    const from = over?.from || pattern.shift?.from;
    if (typeof from !== 'string' || !/^\d{1,2}:\d{2}$/.test(from)) { kept++; continue; }

    const [hh, mm] = from.split(':').map(Number);
    const shiftMin = hh * 60 + mm;
    const inMin = r.check_in ? minutesOfDay(r.check_in) : null;
    if (inMin == null) { kept++; continue; }
    const lateness = inMin - shiftMin;
    if (lateness < 0 || lateness >= 180) { kept++; continue; } // early or >=3h: not provable/wrong

    await prisma.attendance.update({
      where: { id: r.id },
      data: { status: 'LATE', day_credit: 1.0, remarks: `${r.remarks || ''} | ${NOTE}`.slice(0, 250) },
    });
    flipped++;
    console.log(`flipped #${r.id} emp=${r.employeeId} ${d.toISOString().slice(0, 10)} late=${lateness}min HALF_DAY → LATE`);
  }
  console.log(`done: flipped=${flipped} kept(ambiguous/night/≥3h)=${kept}`);
});

await prisma.$disconnect();
