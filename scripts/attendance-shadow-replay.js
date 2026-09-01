// scripts/attendance-shadow-replay.js
//
// Replays real device punches through the HR-ATT-POLICY-01 evaluator and diffs
// the verdict against what is stored in Attendance today. READ-ONLY: it opens no
// transaction and writes nothing, anywhere.
//
// This is the report that turns "these rules sound right" into "these rules
// would have changed N days and moved M of them in the wrong direction". Nothing
// downstream should be switched on before it has been read.
//
//   node scripts/attendance-shadow-replay.js --from 2026-08-01 --to 2026-08-31
//   node scripts/attendance-shadow-replay.js --from ... --to ... --samples 20
//
// HR-ATT-POLICY-01.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { evaluateShift } from "../src/lib/attendanceEvaluator.js";
import { resolveWorkingDays } from "../src/services/workingDay.service.js";
import { getAttendancePolicy } from "../src/services/attendancePolicyConfig.service.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM = arg("from", "2026-08-01");
const TO = arg("to", "2026-08-31");
const SAMPLES = Number(arg("samples", "12"));

const MIN_MS = 60 * 1000;
const startOfDay = (v) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d; };
const dayKey = (d) => startOfDay(d).toISOString().slice(0, 10);

/** "HH:MM" anchored to a day; night shifts roll their end into the next one. */
function shiftFor(pattern, day) {
  const raw = pattern?.shift;
  const mk = (hhmm) => {
    const m = typeof hhmm === "string" ? hhmm.trim().match(/^(\d{1,2}):(\d{2})/) : null;
    if (!m) return null;
    const d = new Date(day);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  };
  const start = mk(raw?.from);
  let end = mk(raw?.to);
  if (start && end && end <= start) end = new Date(end.getTime() + 24 * 60 * MIN_MS);
  return { start, end };
}

/**
 * Group an employee's punches into shifts on the configured gap — the same
 * 11-hour rule the SQL rebuild used, so the two are comparable.
 */
function sessionise(punches, gapHours) {
  const gapMs = gapHours * 60 * MIN_MS;
  const sorted = [...punches].sort((a, b) => a.punchedAt - b.punchedAt);
  const sessions = [];
  let current = null;
  for (const p of sorted) {
    if (!current || p.punchedAt - current.last > gapMs) {
      current = { punches: [], last: p.punchedAt };
      sessions.push(current);
    }
    current.punches.push({
      timestamp: p.punchedAt,
      type: p.status === 0 ? "IN" : p.status === 1 ? "OUT" : "",
    });
    current.last = p.punchedAt;
  }
  return sessions;
}

async function main() {
  // Must be a MODEL query under SYSTEM context, not $queryRaw: raw SQL does not
  // pass through the rls-tenant extension, so no tenant GUC is set, the
  // tenant_isolation policy matches nothing and the scan silently returns zero
  // rows. That failure looks exactly like "there is no data".
  // The await MUST be inside the callback: a Prisma call is a lazy
  // PrismaPromise, so returning it unawaited hands the un-executed query back
  // out of mcpCtx.run, the store unwinds, and it runs with no context
  // (HR-ATT-DEVICE-INTAKE-03, same trap).
  const tenantRows = await mcpCtx.run({ system: true }, async () => {
    return await prisma.attendanceDevicePunch.findMany({
      where: { tenantId: { not: null } },
      distinct: ["tenantId"],
      select: { tenantId: true },
    });
  });
  const tenants = tenantRows.map((r) => ({ t: r.tenantId }));

  const totals = {
    shifts: 0, employees: new Set(), unchanged: 0, changed: 0, newRows: 0,
    byTransition: new Map(), byNewStatus: new Map(), held: 0, creditSum: 0,
  };
  const samples = [];

  for (const { t: tenantId } of tenants) {
    await mcpCtx.run({ user: { tenantId } }, async () => {
      const stored = await getAttendancePolicy({ tenantId });
      // What-if overrides so a policy can be tested BEFORE it is saved.
      const policy = {
        ...stored,
        ...(arg("grace") != null ? { graceMinutes: Number(arg("grace")) } : {}),
        ...(arg("halfday") != null ? { halfDayAfterMinutes: Number(arg("halfday")) } : {}),
      };
      const gapHours = policy.shiftGapHours ?? 11;

      const punches = await prisma.attendanceDevicePunch.findMany({
        where: {
          tenantId,
          employeeId: { not: null },
          punchedAt: { gte: new Date(`${FROM}T00:00:00`), lte: new Date(`${TO}T23:59:59`) },
        },
        select: { employeeId: true, punchedAt: true, status: true },
        orderBy: [{ employeeId: "asc" }, { punchedAt: "asc" }],
      });

      const byEmployee = new Map();
      for (const p of punches) {
        if (!byEmployee.has(p.employeeId)) byEmployee.set(p.employeeId, []);
        byEmployee.get(p.employeeId).push(p);
      }

      for (const [employeeId, rows] of byEmployee) {
        totals.employees.add(employeeId);

        const [schedule, working, stored] = await Promise.all([
          prisma.workSchedule.findFirst({
            where: { employeeId },
            orderBy: { effective_start_date: "desc" },
            select: { schedule_pattern: true },
          }),
          resolveWorkingDays({ employeeId, from: FROM, to: new Date(new Date(TO).getTime() + 86400000) }),
          prisma.attendance.findMany({
            where: { employeeId, date: { gte: startOfDay(FROM), lte: startOfDay(TO) } },
            select: { date: true, status: true, total_hours: true },
          }),
        ]);

        const storedByDay = new Map(stored.map((a) => [dayKey(a.date), a]));

        for (const session of sessionise(rows, gapHours)) {
          const day = startOfDay(session.punches[0].timestamp);
          const shift = shiftFor(schedule?.schedule_pattern, day);

          const tomorrow = new Date(day.getTime() + 86400000);
          const tomorrowInfo = working.get(dayKey(tomorrow));
          const nextShift = shiftFor(schedule?.schedule_pattern, tomorrow);

          const verdict = evaluateShift({
            punches: session.punches,
            shift,
            policy,
            nextDay: {
              working: Boolean(tomorrowInfo?.working),
              nextShiftStart: tomorrowInfo?.working ? nextShift.start : null,
            },
            now: new Date(),
          });

          totals.shifts += 1;
          if (verdict.dayCredit != null) totals.creditSum += verdict.dayCredit;
          else totals.held += 1;

          totals.byNewStatus.set(verdict.status, (totals.byNewStatus.get(verdict.status) ?? 0) + 1);

          const before = storedByDay.get(dayKey(day));
          if (!before) {
            totals.newRows += 1;
            continue;
          }
          if (before.status === verdict.status) {
            totals.unchanged += 1;
            continue;
          }

          totals.changed += 1;
          const key = `${before.status} -> ${verdict.status}`;
          totals.byTransition.set(key, (totals.byTransition.get(key) ?? 0) + 1);
          if (samples.length < SAMPLES) {
            samples.push({
              employeeId, day: dayKey(day), from: before.status, to: verdict.status,
              hoursBefore: before.total_hours,
              worked: verdict.workedMinutes, scheduled: verdict.scheduledMinutes,
              pct: verdict.workedPercent == null ? null : Math.round(verdict.workedPercent),
              late: verdict.latenessMinutes,
            });
          }
        }
      }
    });
  }

  const pct = (n) => (totals.shifts ? ((n / totals.shifts) * 100).toFixed(1) : "0.0");

  console.log(`\n=== SHADOW REPLAY ${FROM} .. ${TO} (read-only) ===`);
  console.log(`employees        ${totals.employees.size}`);
  console.log(`shifts evaluated ${totals.shifts}`);
  console.log(`unchanged        ${totals.unchanged} (${pct(totals.unchanged)}%)`);
  console.log(`CHANGED          ${totals.changed} (${pct(totals.changed)}%)`);
  console.log(`no stored row    ${totals.newRows}`);
  console.log(`HELD (credit null, needs regularization) ${totals.held} (${pct(totals.held)}%)`);
  console.log(`payable day-credit total ${totals.creditSum.toFixed(1)} days`);

  console.log(`\n--- new status distribution ---`);
  for (const [k, v] of [...totals.byNewStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(5)}  ${pct(v)}%`);
  }

  console.log(`\n--- transitions (stored -> evaluator) ---`);
  for (const [k, v] of [...totals.byTransition].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(32)} ${String(v).padStart(5)}`);
  }

  if (samples.length) {
    console.log(`\n--- sample changed days ---`);
    for (const s of samples) {
      console.log(
        `  emp ${String(s.employeeId).padStart(4)} ${s.day}  ${s.from} -> ${s.to}` +
        `  worked ${s.worked}m / sched ${s.scheduled ?? "?"}m` +
        `${s.pct == null ? "" : ` (${s.pct}%)`}${s.late == null ? "" : `  late ${s.late}m`}`,
      );
    }
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
