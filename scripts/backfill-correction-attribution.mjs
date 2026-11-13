// scripts/backfill-correction-attribution.mjs — HR-ATT-CORRECTION-02
//
// Attribute the corrections that went in through one-off scripts.
//
// Of 263 manually_corrected August rows, 221 carry corrected_by_id /
// corrected_at / correction_reason and a Log entry. The other 42 carry only a
// free-text `remarks` string: they are the HR-sheet fills applied by scripts
// that wrote manually_corrected directly instead of going through
// correctAttendanceDay. The service existed; the scripts went around it.
//
// Those rows are correct — they were reconciled against HR's workbook — but
// they are not auditable: no author, no timestamp, no audit row. This backfills
// exactly that, and nothing else. Times, statuses and credits are NOT touched.
//
// The reason text is taken from the remarks the script already wrote, so the
// provenance recorded is the real one rather than a label invented now. The
// timestamp is the row's own updated_at, which is when the script ran — using
// "now" would claim the correction happened today, which is false.
//
//   node scripts/backfill-correction-attribution.mjs --actor EMP214 [from] [to] [--write]
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const actorCode = args[args.indexOf("--actor") + 1];
const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const FROM = dates[0] ?? "2026-08-01";
const TO = dates[1] ?? "2026-09-30";

if (!args.includes("--actor")) {
  console.error("usage: backfill-correction-attribution.mjs --actor <EMPCODE> [from] [to] [--write]");
  process.exit(2);
}

await mcpCtx.run({ system: true }, async () => {
  const actor = await prisma.employee.findFirst({
    where: { employee_code: actorCode },
    select: { id: true, employee_name: true },
  });
  if (!actor) {
    console.error(`--actor ${actorCode} not found`);
    process.exit(2);
  }

  const rows = await prisma.attendance.findMany({
    where: {
      manually_corrected: true,
      corrected_by_id: null,
      date: { gte: new Date(`${FROM}T00:00:00.000Z`), lte: new Date(`${TO}T23:59:59.999Z`) },
    },
    select: {
      id: true, employeeId: true, tenantId: true, date: true, status: true,
      check_in: true, check_out: true, day_credit: true,
      remarks: true, updated_at: true,
    },
    orderBy: [{ date: "asc" }, { employeeId: "asc" }],
  });

  console.log(`unattributed corrections ${FROM}..${TO}: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ${r.date.toISOString().slice(0, 10)} emp=${String(r.employeeId).padEnd(4)} `
      + `${String(r.status).padEnd(17)}${r.remarks ?? "(no remarks)"}`);
  }

  if (!WRITE) {
    console.log(`\ndry run — would attribute to ${actorCode} ${actor.employee_name}`);
    console.log("Re-run with --write to commit.");
    return;
  }

  for (const r of rows) {
    await prisma.attendance.update({
      where: { id: r.id },
      data: {
        corrected_by_id: actor.id,
        // The row's own updated_at is when the script ran. "now" would claim
        // the correction happened today, which is not true.
        corrected_at: r.updated_at ?? new Date(),
        correction_reason: r.remarks ?? "applied by reconciliation script",
      },
    });
    await prisma.log.create({
      data: {
        tenantId: r.tenantId,
        employeeId: r.employeeId,
        attendanceId: r.id,
        actionById: actor.id,
        type: "ATTENDANCE",
        action_type: "ATTENDANCE_CORRECTED",
        module: "attendance",
        ip: "internal",
        os: "internal",
        result: "success",
        notes: `${r.date.toISOString().slice(0, 10)}: attribution backfilled — `
          + `status=${r.status} credit=${r.day_credit ?? "-"} — ${r.remarks ?? "(no remarks)"}`,
      },
    });
  }

  console.log(`\nAPPLIED — ${rows.length} corrections attributed to ${actorCode}`);
});

await prisma.$disconnect().catch(() => {});
