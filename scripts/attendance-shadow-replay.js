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
// Shared with the deduction dry-run: both reports MUST sessionise identically,
// or a status report and a money report would count different shifts.
import { replayTenant, tenantsWithPunches, startOfDay, dayKey } from "../src/lib/attendanceReplay.js";
import { getAttendancePolicy } from "../src/services/attendancePolicyConfig.service.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM = arg("from", "2026-08-01");
const TO = arg("to", "2026-08-31");
const SAMPLES = Number(arg("samples", "12"));


async function main() {
  const tenantIds = await tenantsWithPunches(mcpCtx);

  const totals = {
    shifts: 0, employees: new Set(), unchanged: 0, changed: 0, newRows: 0,
    byTransition: new Map(), byNewStatus: new Map(), held: 0, creditSum: 0,
  };
  const samples = [];

  for (const tenantId of tenantIds) {
    await mcpCtx.run({ user: { tenantId } }, async () => {
      const stored = await getAttendancePolicy({ tenantId });
      // What-if overrides so a policy can be tested BEFORE it is saved.
      const policy = {
        ...stored,
        ...(arg("grace") != null ? { graceMinutes: Number(arg("grace")) } : {}),
        ...(arg("halfday") != null ? { halfDayAfterMinutes: Number(arg("halfday")) } : {}),
      };

      const shifts = await replayTenant({ tenantId, from: FROM, to: TO, policy });

      const employeeIds = [...new Set(shifts.map((s) => s.employeeId))];
      const storedRows = await prisma.attendance.findMany({
        where: {
          employeeId: { in: employeeIds },
          date: { gte: startOfDay(FROM), lte: startOfDay(TO) },
        },
        select: { employeeId: true, date: true, status: true, total_hours: true },
      });
      const storedByKey = new Map(storedRows.map((a) => [`${a.employeeId}|${dayKey(a.date)}`, a]));

      for (const { employeeId, day, verdict } of shifts) {
        totals.employees.add(employeeId);
        totals.shifts += 1;
        if (verdict.dayCredit != null) totals.creditSum += verdict.dayCredit;
        else totals.held += 1;

        totals.byNewStatus.set(verdict.status, (totals.byNewStatus.get(verdict.status) ?? 0) + 1);

        const before = storedByKey.get(`${employeeId}|${dayKey(day)}`);
        if (!before) { totals.newRows += 1; continue; }
        if (before.status === verdict.status) { totals.unchanged += 1; continue; }

        totals.changed += 1;
        const key = `${before.status} -> ${verdict.status}`;
        totals.byTransition.set(key, (totals.byTransition.get(key) ?? 0) + 1);
        if (samples.length < SAMPLES) {
          samples.push({
            employeeId, day: dayKey(day), from: before.status, to: verdict.status,
            worked: verdict.workedMinutes, scheduled: verdict.scheduledMinutes,
            pct: verdict.workedPercent == null ? null : Math.round(verdict.workedPercent),
            late: verdict.latenessMinutes,
          });
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
