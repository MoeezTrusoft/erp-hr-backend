// scripts/orphan-punch-report.mjs — HR-ATT-ORPHAN-RESOLVE-01 (read-only)
//
// Every punch the device sent that no employee owns. Groups them by the device
// user id so the shape of the problem is visible: an id with punches spanning
// months is a person nobody enrolled, an id that stops dead in July is somebody
// who left or was re-enrolled under a new number.
//
// Read-only. Nothing here writes.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

await mcpCtx.run({ system: true }, async () => {
  const orphans = await prisma.attendanceDevicePunch.findMany({
    where: { employeeId: null },
    select: { id: true, deviceUserId: true, punchedAt: true, tenantId: true, sn: true },
    orderBy: [{ deviceUserId: "asc" }, { punchedAt: "asc" }],
  });

  const byId = new Map();
  for (const p of orphans) {
    const k = p.deviceUserId ?? "(null)";
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(p);
  }

  console.log(`orphan punches: ${orphans.length} across ${byId.size} device id(s)\n`);
  console.log("deviceUserId  n     first        last         tenants");
  for (const [id, rows] of [...byId.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const tenants = [...new Set(rows.map((r) => r.tenantId ?? "null"))].map((t) => t.slice(0, 8));
    console.log(
      `${String(id).padEnd(13)} ${String(rows.length).padEnd(5)} ` +
        `${rows[0].punchedAt.toISOString().slice(0, 10)}   ` +
        `${rows[rows.length - 1].punchedAt.toISOString().slice(0, 10)}   ${tenants.join(",")}`,
    );
  }

  // Which of these ids DO match an employee that exists? Those need no model
  // change at all — the punch simply arrived before the id was recorded.
  const ids = [...byId.keys()].filter((k) => k !== "(null)");
  const matches = await prisma.employee.findMany({
    where: { OR: [{ biometric_id: { in: ids } }, { employee_code: { in: ids } }] },
    select: {
      id: true,
      employee_code: true,
      employee_name: true,
      biometric_id: true,
      tenant_id: true,
      status: true,
    },
  });

  console.log(`\nresolvable today (id already on an employee row): ${matches.length}`);
  for (const m of matches) {
    const key = m.biometric_id && byId.has(m.biometric_id) ? m.biometric_id : m.employee_code;
    console.log(
      `  ${String(key).padEnd(8)} -> #${String(m.id).padEnd(5)} ${String(m.employee_code).padEnd(8)} ` +
        `${(m.employee_name ?? "").slice(0, 24).padEnd(24)} ${m.status} ${byId.get(key)?.length ?? 0} punch(es)`,
    );
  }

  const matchedKeys = new Set(
    matches.flatMap((m) => [m.biometric_id, m.employee_code].filter((k) => k && byId.has(k))),
  );
  const unmatched = ids.filter((i) => !matchedKeys.has(i));
  console.log(`\nstill unmatched: ${unmatched.length} -> ${unmatched.join(", ") || "(none)"}`);
});

await prisma.$disconnect().catch(() => {});
process.exit(0);
