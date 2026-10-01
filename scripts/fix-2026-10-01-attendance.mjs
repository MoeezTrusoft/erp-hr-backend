// scripts/fix-2026-10-01-attendance.mjs — one-shot remediation for the
// 2026-10-01 HR report. Four independent problems, one root cause each:
//
//   A. "Absentee dates are not right" — the 2026-09-28 backfill ran on the
//      PKT host, so its UTC-midnight day boundaries serialized as 19:00 the
//      PREVIOUS day. 179 ABSENT rows carry date='...T19:00:00'. HR sees
//      Shahzaib's Sep 22 absence as "Sep 21" and every such day one day early.
//      Fix: shift date +5h onto the intended UTC midnight (idempotent: only
//      rows with extract(hour from date)=19 move).
//
//   B. Duplicates from A — Shahzaib (483) had BOTH 2026-09-21T00:00 (PRESENT,
//      real) and 2026-09-21T19:00 (ABSENT, = Sep 22 mislabeled). After the
//      shift the ABSENT collides with an existing midnight row for the same
//      (employee, day) — delete the arriving duplicate, never the real row.
//
//   C. Separations — Farhan (497, Trusoft, probation) last day Fri 26 Sep
//      (device shows no punches after); Hasher (525, Homenet) left 9 Sep.
//      Close the employment period, flip status Inactive, and delete the
//      post-employment ABSENT rows the nightly marker charged before this ran.
//
//   D. Trusoft checkout margin — the 15:00–00:00 crew legally checks out up
//      to 9h past shift end (Moeez/Subhan, 08:30). Raise the tenant's
//      checkoutLeniencyMin 240 → 540 (missing-checkout cutoff). Pairing itself
//      is fixed in code (ATT-CLOSE-9H-01) and ships with the redeploy.
//
//   E. Re-derive 2026-09-26..2026-10-01 through the fixed evaluator so the
//      Oct 1 rows stop wearing Moeez/Subhan's morning check-out as check-in,
//      then audit duplicates and missing-date records fleet-wide for
//      2026-09-01..2026-10-01 and print the full HR list.
//
// DRY RUN BY DEFAULT — `node scripts/fix-2026-10-01-attendance.mjs` reports;
// pass --write to commit. Every phase is idempotent.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { applyEvaluatedShifts } from "../src/services/attendanceWriter.service.js";

await mcpCtx.run({ system: true }, async () => {

const WRITE = process.argv.includes("--write");
const TENANT_TRUSOFT = "40314ef4-0a81-4390-b631-b3ad3f21f523";
const TENANT_HOMENET = "8ff0533b-62f6-4be9-a78e-69adf49e00bc";
const PKT_MS = 5 * 60 * 60 * 1000; // Asia/Karachi is UTC+5 (no DST) — the 19:00 offset
const FROM = "2026-09-01";
const TO = "2026-10-01";
const REEVAL_FROM = "2026-09-26";
const REEVAL_TO = "2026-10-01";

// ── the five people ────────────────────────────────────────────────────────
const people = await prisma.employee.findMany({
  where: { id: { in: [483, 484, 491, 497, 525] } },
  select: {
    id: true, tenant_id: true, employee_code: true,
    first_name: true, last_name: true, employement_status: true,
    biometric_id: true, payroll_included: true,
  },
});
const byId = new Map(people.map((e) => [e.id, e]));
console.log(`# mode=${WRITE ? "WRITE" : "DRY-RUN"}`);
for (const e of people) {
  console.log(`# emp ${e.id} ${e.employee_code} ${e.first_name} ${e.last_name} ` +
    `status=${e.employement_status} biometric=${e.biometric_id} payroll=${e.payroll_included}`);
}

// ── A. shift 19:00-dated ABSENT rows onto the intended UTC midnight ───────
// (Model queries throughout — $queryRaw runs on a pool connection where the
// tenant GUC is not set, so forced RLS hides every row from raw SQL here.)
//
// ORDER MATTERS: an ABSENT row can only move onto a day that has NO row yet.
// Where the target day already has one (a real PRESENT row, or another
// ABSENT), the shifted row would violate Attendance_tenant_employee_day_key —
// so the collision is resolved FIRST by deleting the ABSENT row, never the
// real one. Deletion is the fix: the ABSENT row's date is wrong and its day
// is accounted for by the row that already exists.
console.log("\n== A. 19:00-dated ABSENT rows: dedupe against target day, then +5h ==");
const absentRows = await prisma.attendance.findMany({
  where: {
    status: "ABSENT",
    date: { gte: new Date(`${FROM}T00:00:00Z`), lt: new Date(`${TO}T00:00:00Z`) },
  },
  select: { id: true, employeeId: true, date: true, status: true, created_at: true },
});
const misplaced = absentRows.filter((r) => r.date.getUTCHours() === 19);
console.log(`19:00-dated ABSENT rows: ${misplaced.length}`);

// Rows already present on each target day (id, status) — the collision map.
// Fetched across ALL attendance rows in the window once, then keyed.
const allRows = await prisma.attendance.findMany({
  where: { date: { gte: new Date(`${FROM}T00:00:00Z`), lt: new Date(`${TO}T00:00:00Z`) } },
  select: { id: true, employeeId: true, date: true, status: true },
});
const byEmpDay = new Map();
for (const r of allRows) {
  const key = `${r.employeeId}|${r.date.toISOString().slice(0, 10)}`;
  if (!byEmpDay.has(key)) byEmpDay.set(key, []);
  byEmpDay.get(key).push(r);
}

const toShift = [];
const toDelete = [];
for (const r of misplaced) {
  const target = new Date(r.date.getTime() + PKT_MS);
  const key = `${r.employeeId}|${target.toISOString().slice(0, 10)}`;
  // Occupants that matter are rows that will STILL be on the target day after
  // this run: another 19:00-dated ABSENT row moves away (+5h) itself, so it
  // does not block. Without this exclusion a run of consecutive absence days
  // would cascade-delete all but the last row (each target "occupied" by the
  // next day's 19:00 row). Genuine occupants — device rows, weekly offs and
  // midnight ABSENTs — do block, and the incoming ABSENT loses to them.
  const occupants = (byEmpDay.get(key) ?? []).filter(
    (o) => o.id !== r.id && !(o.status === "ABSENT" && o.date.getUTCHours() === 19),
  );
  if (occupants.length === 0) {
    toShift.push({ id: r.id, from: r.date, to: target });
  } else {
    // The intended day already has a settled row — the ABSENT row is a
    // duplicate of it (or of the day the occupancy accounts for). Drop it.
    toDelete.push({ id: r.id, emp: r.employeeId, target: key, occupants });
  }
}
console.log(`plan: ${toShift.length} to shift (+5h), ${toDelete.length} to delete (target day occupied)`);
for (const d of toDelete.slice(0, 12)) {
  console.log(`  DEL emp ${d.emp} ${d.target}: occupied by ids ${d.occupants.map((o) => `${o.id}(${o.status})`).join(",")}`);
}
if (toDelete.length > 12) console.log(`  ... and ${toDelete.length - 12} more`);

if (WRITE) {
  for (const d of toDelete) {
    await prisma.attendance.deleteMany({ where: { id: d.id } });
  }
  console.log(`deleted ${toDelete.length} duplicate ABSENT rows`);
  for (const s of toShift) {
    await prisma.attendance.update({ where: { id: s.id }, data: { date: s.to } });
  }
  console.log(`shifted ${toShift.length} rows by +5h to their intended UTC midnight`);
}

// ── B. delete duplicates created by the shift (kept from the ORIGINAL plan:
//      the arriving ABSENT loses to any existing row on the target day) ────
console.log("\n== B. duplicate ABSENT rows after the shift ==");
const afterRows = WRITE
  ? await prisma.attendance.findMany({
      where: { date: { gte: new Date(`${FROM}T00:00:00Z`), lt: new Date(`${TO}T00:00:00Z`) } },
      select: { id: true, employeeId: true, date: true, status: true },
    })
  : absentRows;
const groups = new Map();
for (const r of afterRows) {
  const key = `${r.employeeId}|${r.date.toISOString().slice(0, 10)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const dupGroups = [...groups.entries()]
  .filter(([, list]) => list.length > 1)
  .map(([key, list]) => ({
    employeeId: Number(key.split("|")[0]),
    day: key.split("|")[1],
    ids: list.map((r) => r.id),
    statuses: list.map((r) => r.status),
    list,
  }));
console.log(`duplicate (employee, day) groups in Sep..Oct: ${dupGroups.length} ${WRITE ? "(post-shift)" : "(pre-shift — dry run)"}`);
const doomed = [];
for (const g of dupGroups) {
  // The evaluator's midnight row is authoritative; the ABSENT marker's row is
  // the intruder. Keep the FIRST (lowest id = pre-existing) non-ABSENT row;
  // if every row is ABSENT keep the lowest id and drop the rest.
  const real = g.ids.find((id, i) => g.statuses[i] !== "ABSENT");
  const keep = real ?? g.ids[0];
  for (const r of g.list) if (r.id !== keep) doomed.push(r.id);
  console.log(`  emp ${g.employeeId} ${g.day}: ids=${g.ids} statuses=${g.statuses} -> keep ${keep}, delete ${g.ids.filter((x) => x !== keep)}`);
}
if (WRITE && doomed.length) {
  const res = await prisma.attendance.deleteMany({ where: { id: { in: doomed } } });
  console.log(`deleted ${res.count} duplicate rows`);
}

// ── C. separations ─────────────────────────────────────────────────────────
console.log("\n== C. separations ==");
const SEPARATIONS = [
  { id: 497, tenantId: TENANT_TRUSOFT, name: "Muhammad Farhan", lastDay: "2026-09-26", reason: "resignation", note: "Left during probation; last working day 2026-09-26 (shift end, per HR 2026-10-01). Device shows no punches after 2026-09-26." },
  { id: 525, tenantId: TENANT_HOMENET, name: "Hasher Khan", lastDay: "2026-09-09", reason: "resignation", note: "Left the job 2026-09-09 (last working day, per HR 2026-10-01). Sep 9 late-departure punch and its Sep 10 duplicate are retained." },
];
for (const s of SEPARATIONS) {
  const end = new Date(`${s.lastDay}T23:59:59.999Z`);
  const open = await prisma.employmentPeriod.findFirst({
    where: { employeeId: s.id, endDate: null },
    orderBy: { startDate: "desc" },
  });
  const closedAlready = await prisma.employmentPeriod.findFirst({
    where: { employeeId: s.id, endDate: { not: null, gte: new Date(`${s.lastDay}T00:00:00Z`), lte: end } },
  });
  if (closedAlready) {
    console.log(`  ${s.name}: period already ends ${closedAlready.endDate?.toISOString()} — skip`);
  } else if (open) {
    console.log(`  ${s.name}: close open period (start ${open.startDate?.toISOString()}) at ${s.lastDay}T23:59:59.999Z [${s.reason}]`);
    if (WRITE) {
      await prisma.employmentPeriod.update({
        where: { id: open.id },
        data: { endDate: end, reason: s.reason, note: s.note },
      });
    }
  } else {
    console.log(`  ${s.name}: no open period — creating one ending ${s.lastDay}`);
    if (WRITE) {
      await prisma.employmentPeriod.create({
        data: { employeeId: s.id, tenantId: s.tenantId, startDate: new Date("2026-01-01T00:00:00Z"), endDate: end, reason: s.reason, note: s.note },
      });
    }
  }
  const emp = byId.get(s.id);
  if (emp?.employement_status !== "Inactive") {
    console.log(`  ${s.name}: status ${emp.employement_status} -> Inactive`);
    if (WRITE) {
      await prisma.employee.update({ where: { id: s.id }, data: { employement_status: "Inactive" } });
    }
  }
  // Post-separation ABSENT rows charged after the last day — remove them.
  const postAbs = await prisma.attendance.findMany({
    where: {
      employeeId: s.id, status: "ABSENT", manually_corrected: false,
      date: { gt: end },
    },
    select: { id: true, date: true },
  });
  if (postAbs.length) {
    console.log(`  ${s.name}: delete ${postAbs.length} post-separation ABSENT rows: ${postAbs.map((r) => r.date.toISOString().slice(0, 10)).join(", ")}`);
    if (WRITE) {
      await prisma.attendance.deleteMany({ where: { id: { in: postAbs.map((r) => r.id) } } });
    }
  }
  // Hasher's stray post-employment punch: a lone 2026-09-10 11:23:50 device
  // OUT a day after he left. It manufactured the Sep 9 MISSING_CHECKIN row
  // (as its check-out) and the Sep 10 PRESENT row (as its check-in). Removing
  // the punch lets the re-derivation retract both rows; the raw audit trail
  // of this deletion lives in this script's git history.
  if (s.id === 525) {
    const stray = await prisma.attendanceDevicePunch.findMany({
      where: { employeeId: s.id, punchedAt: { gt: end } },
      select: { id: true, punchedAt: true, status: true },
    });
    if (stray.length) {
      console.log(`  ${s.name}: delete ${stray.length} post-employment punch(es): ${stray.map((p) => `${p.id}@${p.punchedAt.toISOString()}(st${p.status})`).join(", ")}`);
      if (WRITE) {
        await prisma.attendanceDevicePunch.deleteMany({ where: { id: { in: stray.map((p) => p.id) } } });
      }
    }
  }
}

// ── D. Trusoft checkout leniency 240 -> 540 (9h) ───────────────────────────
console.log("\n== D. Trusoft checkoutLeniencyMin ==");
const pol = await prisma.attendancePolicyConfig.findUnique({ where: { tenantId: TENANT_TRUSOFT } });
console.log(`current: ${pol?.checkoutLeniencyMin ?? "(no row, default 240)"} -> 540`);
if (WRITE) {
  await prisma.attendancePolicyConfig.upsert({
    where: { tenantId: TENANT_TRUSOFT },
    create: {
      tenantId: TENANT_TRUSOFT, checkoutLeniencyMin: 540, status: "PUBLISHED", version: 1,
      graceMinutes: 5, halfDayAfterMinutes: 30, earlyLeaveGraceMin: 0,
      overtimeAfterMinutes: 45, overtimeNeedsApproval: true,
      fullDayMinPercent: 90, halfDayMinPercent: 50,
      halfDayAfterPercentOfShift: null, duplicatePunchWindowMin: 5,
      shiftGapHours: 11, defaultShiftStart: "09:00",
    },
    update: { checkoutLeniencyMin: 540, version: { increment: 1 } },
  });
  console.log("policy updated: checkoutLeniencyMin=540");
}

// ── E. re-derive the window + fleet audit ──────────────────────────────────
console.log(`\n== E. re-derive ${REEVAL_FROM}..${REEVAL_TO} (fixes Moeez/Subhan 1 Oct) ==`);
for (const [name, tenantId] of Object.entries({
  Trusoft: TENANT_TRUSOFT, Homenet: TENANT_HOMENET,
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
})) {
  const res = await mcpCtx.run({ user: { tenantId } }, async () =>
    applyEvaluatedShifts({ tenantId, from: REEVAL_FROM, to: REEVAL_TO, dryRun: !WRITE }),
  );
  console.log(`${name.padEnd(8)} shifts=${res.shifts} created=${res.created} updated=${res.updated} ` +
    `unchanged=${res.unchanged} hrCorrected=${res.skippedManuallyCorrected} ${JSON.stringify(res.byStatus)}`);
}

console.log(`\n== F. audit ${FROM}..${TO}: duplicates + missing dates (per tenant) ==`);
const tenants = await prisma.employee.findMany({
  where: { tenant_id: { not: null } },
  select: { tenant_id: true },
  distinct: ["tenant_id"], orderBy: { tenant_id: "asc" },
});
const names = await prisma.employee.findMany({
  select: { id: true, first_name: true, last_name: true, employee_code: true },
});
const nameOf = new Map(names.map((e) => [e.id, `${e.first_name} ${e.last_name} (${e.employee_code})`]));
// Days up to YESTERDAY can be judged complete; today's shifts are still open
// (evening crews have not scanned in yet), so they are not "missing".
const TODAY = new Date().toISOString().slice(0, 10);
const days = [];
for (let d = new Date(`${FROM}T00:00:00Z`); d < new Date(`${TODAY}T00:00:00Z`); d = new Date(d.getTime() + 86400000)) {
  days.push(d.toISOString().slice(0, 10));
}
for (const { tenant_id: tid } of tenants) {
  const emps = await prisma.employee.findMany({
    where: { tenant_id: tid, payroll_included: true },
    select: { id: true },
  });
  // Employment windows: a separation (or pre-hire gap) explains its own
  // "missing" dates — those are not defects and must not reach HR's list.
  const periodRows = await prisma.employmentPeriod.findMany({
    where: { employeeId: { in: emps.map((e) => e.id) } },
    select: { employeeId: true, startDate: true, endDate: true },
  });
  const periodsByEmp = new Map();
  for (const p of periodRows) {
    if (!periodsByEmp.has(p.employeeId)) periodsByEmp.set(p.employeeId, []);
    periodsByEmp.get(p.employeeId).push(p);
  }
  const employedOn = (id, day) => {
    const list = periodsByEmp.get(id);
    if (!list?.length) return true; // no periods on file → legacy behaviour
    return list.some(
      (p) => p.startDate?.getTime() <= day.getTime() &&
        (p.endDate == null || day.getTime() <= p.endDate.getTime()),
    );
  };
  const rows = await prisma.attendance.findMany({
    where: { tenantId: tid, date: { gte: new Date(`${FROM}T00:00:00Z`), lte: new Date(`${TO}T23:59:59.999Z`) } },
    select: { employeeId: true, date: true, status: true, id: true },
    orderBy: { date: "asc" },
  });
  // Raw punches in the window, per employee — a missing-date stretch WITH
  // punches points at unresolved enrolment/derivation; without, at a device
  // or roster gap.
  const punchRows = await prisma.attendanceDevicePunch.findMany({
    where: { tenantId: tid, punchedAt: { gte: new Date(`${FROM}T00:00:00Z`), lte: new Date(`${TO}T23:59:59.999Z`) } },
    select: { employeeId: true },
  });
  const punchCount = new Map();
  let orphanPunches = 0;
  for (const p of punchRows) {
    if (p.employeeId == null) { orphanPunches += 1; continue; }
    punchCount.set(p.employeeId, (punchCount.get(p.employeeId) ?? 0) + 1);
  }
  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, []);
    byEmp.get(r.employeeId).push(r);
  }
  console.log(`\n-- tenant ${tid}: ${emps.length} payroll employees, ${rows.length} attendance rows, orphan punches: ${orphanPunches}`);
  let dupTotal = 0, missTotal = 0;
  for (const emp of emps) {
    const list = (byEmp.get(emp.id) ?? []).filter((r) => days.includes(r.date.toISOString().slice(0, 10)));
    const seen = new Map();
    const dups = [];
    for (const r of list) {
      const k = r.date.toISOString().slice(0, 10);
      if (seen.has(k)) dups.push(`${k}: ids ${seen.get(k)}+${r.id} (${r.status})`);
      else seen.set(k, r.id);
    }
    const missing = days.filter((d) => {
      if (seen.has(d)) return false;
      const day = new Date(`${d}T00:00:00Z`);
      return employedOn(emp.id, day);
    });
    if (dups.length) {
      dupTotal += dups.length;
      console.log(`  DUP ${nameOf.get(emp.id)}: ${dups.join(" | ")}`);
    }
    if (missing.length) {
      missTotal += missing.length;
      console.log(`  MISS ${nameOf.get(emp.id)} [punches in window: ${punchCount.get(emp.id) ?? 0}]: ${missing.join(", ")}`);
    }
  }
  console.log(`  => tenant totals: ${dupTotal} duplicate rows, ${missTotal} missing-date records`);
}

console.log(`\nDone (${WRITE ? "WRITE" : "dry run"}).`);
});
await prisma.$disconnect().catch(() => {});
process.exit(0);
