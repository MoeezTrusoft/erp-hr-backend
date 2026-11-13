// scripts/august-day-detail.mjs — HR-ATT-RECON-FINAL-01 (read-only)
//
// Every August attendance day we hold, one row each, with the punch times.
// Emitted as JSON so the workbook comparison happens off-cluster.
//
// Read-only. Nothing here writes.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-08-31T23:59:59.999Z");
const hhmm = (d) => (d ? new Date(d).toISOString().slice(11, 16) : null);

await mcpCtx.run({ system: true }, async () => {
  const employees = await prisma.employee.findMany({
    select: {
      id: true, employee_code: true, employee_name: true,
      first_name: true, last_name: true, tenant_id: true,
      biometric_id: true, status: true,
    },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  const rows = await prisma.attendance.findMany({
    where: { date: { gte: FROM, lte: TO } },
    select: {
      employeeId: true, date: true, status: true,
      check_in: true, check_out: true, manually_corrected: true,
    },
    orderBy: [{ employeeId: "asc" }, { date: "asc" }],
  });

  const out = rows.map((r) => {
    const e = byId.get(r.employeeId) || {};
    return {
      employeeId: r.employeeId,
      code: e.employee_code ?? null,
      name: e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
      tenantId: e.tenant_id ?? null,
      biometricId: e.biometric_id ?? null,
      date: r.date.toISOString().slice(0, 10),
      status: r.status,
      in: hhmm(r.check_in),
      out: hhmm(r.check_out),
      corrected: r.manually_corrected,
    };
  });

  console.error(`days=${out.length} employees=${new Set(out.map((r) => r.employeeId)).size}`);
  console.log(JSON.stringify(out));
});

await prisma.$disconnect().catch(() => {});
// No process.exit() here. stdout is a pipe, so writes are asynchronous, and
// exiting discards whatever has not drained — this payload is ~400KB and was
// arriving cut off at exactly 65536 bytes. Let the event loop end on its own.
