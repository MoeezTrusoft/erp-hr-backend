// scripts/name-candidates.mjs — HR-ATT-RECON-FINAL-01 (read-only)
//
// Everything we hold on the employees behind the ambiguous HR sheet names, so a
// human can settle them from evidence rather than from a guess. Prints the
// tenant, device enrolment, hire date and August shape of each candidate.
//
// Read-only. Nothing here writes.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const NEEDLES = ["asad", "arsalan", "qasim", "yaseen", "huzaifa"];
const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};
const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-08-31T23:59:59.999Z");
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

await mcpCtx.run({ system: true }, async () => {
  for (const [tenant, tenantId] of Object.entries(TENANTS)) {
    const emps = await prisma.employee.findMany({
      where: { tenant_id: tenantId },
      select: {
        id: true, employee_code: true, employee_name: true, first_name: true,
        last_name: true, biometric_id: true, status: true, job_title: true,
        hire_date: true, joining_date: true,
      },
      orderBy: { employee_code: "asc" },
    });

    for (const e of emps) {
      const name = (e.employee_name || `${e.first_name ?? ""} ${e.last_name ?? ""}`).trim();
      if (!NEEDLES.some((n) => name.toLowerCase().includes(n))) continue;

      const rows = await prisma.attendance.findMany({
        where: { employeeId: e.id, date: { gte: FROM, lte: TO } },
        select: { date: true, status: true, check_in: true, check_out: true },
        orderBy: { date: "asc" },
      });
      const byStatus = {};
      for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

      const sched = await prisma.workSchedule.findFirst({
        where: { employeeId: e.id },
        orderBy: { effective_start_date: "desc" },
        select: { schedule_pattern: true },
      });
      const p = sched?.schedule_pattern;
      const shift = p?.rotatingShifts
        ? `rotating ${p.rotatingShifts.map((s) => s.from).join("/")}`
        : p?.shift
          ? `${p.shift.from}-${p.shift.to}`
          : "—";
      const off = Array.isArray(p?.offDays) && p.offDays.length ? p.offDays.join(",") : "—";

      const punches = await prisma.attendanceDevicePunch.count({
        where: { employeeId: e.id, punchedAt: { gte: FROM, lte: TO } },
      });

      console.log(
        `${tenant.padEnd(8)} ${String(e.employee_code).padEnd(8)} ${name.slice(0, 26).padEnd(26)} ` +
          `bio=${String(e.biometric_id ?? "—").padEnd(6)} status=${String(e.status).padEnd(8)} ` +
          `hired=${iso(e.hire_date)} shift=${shift.padEnd(18)} off=${String(off).padEnd(5)} ` +
          `augDays=${String(rows.length).padStart(2)} punches=${String(punches).padStart(3)} ` +
          `${JSON.stringify(byStatus)}`,
      );
      console.log(`         title=${e.job_title ?? "—"}`);
    }
  }
});

await prisma.$disconnect().catch(() => {});
