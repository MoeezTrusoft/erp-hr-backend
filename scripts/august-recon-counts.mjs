// scripts/august-recon-counts.mjs — HR-ATT-RECON-FINAL-01 (read-only)
//
// Our August verdicts, per employee, in the SHAPE HR's own Summary sheet uses:
// absence / late check-in / early check-out / check-in missing / check-out
// missing. Emits JSON on stdout so the comparison against the workbook happens
// off-cluster.
//
// One caveat is structural and worth stating rather than papering over:
// `Attendance.status` is single-valued and MISSING_* outranks LATE, so a day
// that was BOTH late and missing a check-out lands in one of our buckets and
// two of HR's. The LATE_CHECKIN anomaly still records the lateness, so lateness
// is counted from the anomaly rather than the status — that is the only way the
// two sides can be compared column by column.
//
// Read-only. Nothing here writes.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-08-31T23:59:59.999Z");

await mcpCtx.run({ system: true }, async () => {
  const employees = await prisma.employee.findMany({
    select: {
      id: true,
      employee_code: true,
      employee_name: true,
      first_name: true,
      last_name: true,
      tenant_id: true,
      status: true,
    },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  const att = await prisma.attendance.findMany({
    where: { date: { gte: FROM, lte: TO } },
    select: { employeeId: true, date: true, status: true },
  });

  const anom = await prisma.attendanceAnomaly.findMany({
    where: { date: { gte: FROM, lte: TO } },
    select: { employeeId: true, date: true, type: true, status: true },
  });

  const blank = () => ({
    absent: 0,
    late: 0,
    early: 0,
    cin_missing: 0,
    cout_missing: 0,
    present: 0,
    half_day: 0,
    approved: 0,
  });
  const tally = new Map();
  const lateDays = new Set(); // employee|day already charged a LATE status
  const get = (id) => {
    if (!tally.has(id)) tally.set(id, blank());
    return tally.get(id);
  };

  for (const a of att) {
    const t = get(a.employeeId);
    if (a.status === "ABSENT") t.absent += 1;
    else if (a.status === "PRESENT") t.present += 1;
    else if (a.status === "HALF_DAY") t.half_day += 1;
    else if (a.status === "MISSING_CHECKIN") t.cin_missing += 1;
    else if (a.status === "MISSING_CHECKOUT") t.cout_missing += 1;
    else if (a.status === "LATE") {
      t.late += 1;
      lateDays.add(`${a.employeeId}|${a.date.toISOString().slice(0, 10)}`);
    }
  }

  // Anomalies are EMPLOYEE-RAISED forms, not evaluator output — there are only
  // a handful for the whole month. They are read for two reasons: an approved
  // one excuses the day, and a LATE_CHECKIN on a day whose status is
  // MISSING_CHECKOUT is lateness the single-valued status column could not
  // hold. HR counts that day in both columns, so we must too.
  const seen = new Set();
  for (const a of anom) {
    const day = a.date.toISOString().slice(0, 10);
    const key = `${a.employeeId}|${day}|${a.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = get(a.employeeId);
    if (a.status === "APPROVED") {
      t.approved += 1;
      continue; // an approved anomaly is excused; HR does not charge it
    }
    if (a.type === "LATE_CHECKIN") {
      if (!lateDays.has(`${a.employeeId}|${day}`)) t.late += 1;
    } else if (a.type === "EARLY_CHECKOUT") t.early += 1;
  }

  const out = [];
  for (const [id, t] of tally) {
    const e = byId.get(id);
    if (!e) continue;
    out.push({
      employeeId: id,
      code: e.employee_code,
      name: e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" "),
      tenantId: e.tenant_id,
      status: e.status,
      ...t,
    });
  }
  out.sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const sum = (k) => out.reduce((n, r) => n + r[k], 0);
  console.error(
    `OURS absent=${sum("absent")} late=${sum("late")} early=${sum("early")} ` +
      `cin_missing=${sum("cin_missing")} cout_missing=${sum("cout_missing")} ` +
      `present=${sum("present")} half_day=${sum("half_day")} approved=${sum("approved")} ` +
      `employees=${out.length}`,
  );
  console.log(JSON.stringify(out));
});

await prisma.$disconnect().catch(() => {});
process.exit(0);
