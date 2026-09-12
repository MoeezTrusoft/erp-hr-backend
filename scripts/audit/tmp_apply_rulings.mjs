// Operator rulings 2026-09-11 — batch fixes:
//  F1: re-bucket remaining writer-derived HALF_DAY rows with the DAY-APPROPRIATE
//      shift (rotation-aware) and the >3h rule: ≤0 PRESENT, <180 LATE, ≥180 HALF_DAY.
//  F2: blank-column employees are not attendance-tracked (HR charges 0) — their
//      AUGUST-BACKFILL ABSENT rows become paid days with a policy remark.
//  F3: Meesam's August spell ends Aug 19 (termination day Aug 20 not payable).
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
import { minutesOfDay } from '../src/lib/attendanceStatus.js';

const T = {
  TRUSOFT: '40314ef4-0a81-4390-b631-b3ad3f21f523',
  HOMENET: '8ff0533b-62f6-4be9-a78e-69adf49e00bc',
  JOC: '8f4a526f-d45b-4da2-b772-d6682e849812',
};
const DAY_MS = 86400000;
const nearest = (inMin, shiftMin) => {
  const delta = inMin - shiftMin;
  if (delta < -720) return shiftMin - 1440;
  if (delta > 720) return shiftMin + 1440;
  return shiftMin;
};
const bucket = (lateMin) => (lateMin <= 0 ? 'PRESENT' : lateMin < 180 ? 'LATE' : 'HALF_DAY');
const CREDIT = { PRESENT: 1.0, LATE: 1.0, HALF_DAY: 0.5 };

await mcpCtx.run({ system: true }, async () => {
  // ── F1 ──────────────────────────────────────────────────────────────────
  const rows = await prisma.attendance.findMany({
    where: { status: 'HALF_DAY', date: { gte: new Date('2026-08-01T00:00:00Z'), lt: new Date('2026-09-12T00:00:00Z') } },
    select: { id: true, employeeId: true, date: true, check_in: true, remarks: true },
  });
  const schedules = await prisma.workSchedule.findMany({
    where: { employeeId: { in: [...new Set(rows.map((r) => r.employeeId))] } },
    select: { employeeId: true, schedule_pattern: true, effective_start_date: true, effective_end_date: true },
  });
  let f1 = 0, kept1 = 0;
  for (const r of rows) {
    const d = r.date;
    const inMin = r.check_in ? minutesOfDay(r.check_in) : null;
    if (inMin == null) { kept1++; continue; }
    const sched = schedules.find(
      (s) => s.employeeId === r.employeeId && s.effective_start_date <= d && (!s.effective_end_date || s.effective_end_date >= d),
    );
    const p = sched?.schedule_pattern;
    let shiftMin = null;
    if (p?.type === 'weekly' && !p.crossesMidnight) {
      const jsKey = String(d.getUTCDay());
      const isoKey = String(((d.getUTCDay() + 6) % 7) + 1);
      const over = p.shiftByDay?.[jsKey] ?? p.shiftByDay?.[isoKey];
      const from = over?.from ?? p.shift?.from;
      if (typeof from === 'string' && /^\d{1,2}:\d{2}$/.test(from)) {
        const [h, m] = from.split(':').map(Number);
        shiftMin = h * 60 + m;
      }
    } else if (p?.type === 'rotating' && Array.isArray(p.rotatingShifts) && p.cycle) {
      const anchor = new Date(p.cycle.anchor);
      const idx = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate())) / DAY_MS);
      const cyc = ((idx % p.cycle.days) + p.cycle.days) % p.cycle.days;
      if (cyc === Number(p.cycle.offIndex)) { kept1++; continue; } // rest-day row — leave
      const sh = p.rotatingShifts[cyc % p.rotatingShifts.length];
      if (typeof sh?.from === 'string' && /^\d{1,2}:\d{2}$/.test(sh.from)) {
        const [h, m] = sh.from.split(':').map(Number);
        shiftMin = h * 60 + m;
      }
    }
    if (shiftMin == null) { kept1++; continue; }
    const lateMin = inMin - nearest(inMin, shiftMin);
    const target = bucket(lateMin);
    if (target === 'HALF_DAY') { kept1++; continue; } // genuinely ≥3h late
    await prisma.attendance.update({
      where: { id: r.id },
      data: { status: target, day_credit: CREDIT[target], remarks: `${r.remarks || ''} | POLICY 2026-09-11: >3h=HALF_DAY re-bucket (${lateMin}min vs shift)`.slice(0, 250) },
    });
    f1++;
    console.log(`F1 #${r.id} emp=${r.employeeId} ${d.toISOString().slice(0, 10)} ${lateMin}min → ${target}`);
  }
  console.log(`F1: rebucketed=${f1} kept=${kept1}`);

  // ── F2 ──────────────────────────────────────────────────────────────────
  const names = ['Jamshed Ur Rehman', 'Tanveer', 'Usman Khan', 'Akash Nanu', 'Syed Sibte Baqar Abidi'];
  const emps = await prisma.employee.findMany({
    where: { OR: names.map((n) => ({ first_name: { contains: n.split(' ')[0] }, last_name: { contains: n.split(' ').slice(-1)[0] } })) },
    select: { id: true, tenant_id: true, first_name: true, last_name: true },
  });
  const picked = [];
  for (const n of names) {
    const hit = emps.find((e) => `${e.first_name} ${e.last_name || ''}`.toLowerCase().includes(n.toLowerCase().split(' ').slice(-1)[0].toLowerCase()))
      || emps.find((e) => `${e.first_name} ${e.last_name || ''}`.toLowerCase().includes(n.toLowerCase()));
    if (hit) picked.push(hit); else console.log(`F2: NO MATCH for "${n}"`);
  }
  for (const e of picked) console.log(`F2 target: #${e.id} ${e.first_name} ${e.last_name || ''}`);
  let f2 = 0;
  for (const e of picked) {
    const upd = await prisma.attendance.updateMany({
      where: { employeeId: e.id, tenantId: e.tenant_id, status: 'ABSENT', remarks: { contains: 'AUGUST-BACKFILL' }, date: { gte: new Date('2026-08-01T00:00:00Z'), lt: new Date('2026-09-01T00:00:00Z') } },
      data: { status: 'PRESENT', day_credit: 1.0, remarks: 'POLICY 2026-09-11: non-attendance-tracked staff (HR register charges 0); blank scheduled days paid' },
    });
    f2 += upd.count;
    console.log(`F2 emp=${e.id}: ${upd.count} backfilled absences → PRESENT`);
  }
  console.log(`F2: total=${f2}`);

  // ── F3 ──────────────────────────────────────────────────────────────────
  const meesam = await prisma.employmentPeriod.findFirst({
    where: { employeeId: 495, startDate: { lte: new Date('2026-08-31T23:59:59Z') }, OR: [{ endDate: null }, { endDate: { gte: new Date('2026-08-01T00:00:00Z') } }] },
  });
  if (meesam) {
    console.log(`F3: Meesam period #${meesam.id} ${meesam.startDate?.toISOString()} → ${meesam.endDate?.toISOString() ?? 'open'}`);
    await prisma.employmentPeriod.update({
      where: { id: meesam.id },
      data: { endDate: new Date('2026-08-19T23:59:59.999Z') },
    });
    console.log('F3: spell closed Aug 19 (Aug 20 termination day not payable)');
  } else {
    console.log('F3: Meesam August period NOT FOUND — check field names');
  }
});

await prisma.$disconnect();
