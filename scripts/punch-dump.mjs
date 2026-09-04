// scripts/punch-dump.mjs — raw device punches for one employee over a window.
//
//   node scripts/punch-dump.mjs EMP162 2026-08-05 2026-08-09
//
// Read-only. Prints the device's own status code, which is the thing under
// suspicion when a shift's closing scan reappears as the next day's arrival.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const [code, from, to] = process.argv.slice(2);
if (!code || !from || !to) {
  console.error("usage: punch-dump.mjs <EMPCODE> <from> <to>");
  process.exit(2);
}

const STATUS = { 0: "IN", 1: "OUT", 2: "BREAK-OUT", 3: "BREAK-IN", 4: "OT-IN", 5: "OT-OUT" };

await mcpCtx.run({ system: true }, async () => {
  const emp = await prisma.employee.findFirst({
    where: { employee_code: code },
    select: { id: true, employee_name: true, biometric_id: true, tenant_id: true },
  });
  if (!emp) {
    console.log(`${code} not found`);
    return;
  }
  console.log(`${code} ${emp.employee_name} biometric=${emp.biometric_id}`);

  const punches = await prisma.attendanceDevicePunch.findMany({
    where: {
      employeeId: emp.id,
      punchedAt: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) },
    },
    select: { punchedAt: true, status: true, deviceUserId: true },
    orderBy: { punchedAt: "asc" },
  });
  for (const p of punches) {
    console.log(
      `  ${p.punchedAt.toISOString().slice(0, 16).replace("T", " ")}  ` +
        `status=${p.status} ${(STATUS[p.status] ?? "?").padEnd(9)} id=${p.deviceUserId}`,
    );
  }
  console.log(`  (${punches.length} punches)`);

  const sched = await prisma.workSchedule.findFirst({
    where: { employeeId: emp.id },
    orderBy: { effective_start_date: "desc" },
    select: { schedule_pattern: true },
  });
  console.log(`  roster: ${JSON.stringify(sched?.schedule_pattern ?? null)}`);
});

await prisma.$disconnect().catch(() => {});
