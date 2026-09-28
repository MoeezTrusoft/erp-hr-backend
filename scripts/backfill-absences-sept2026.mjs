// scripts/backfill-absences-sept2026.mjs — HR-ATT-ABSENCE-02 backfill.
//
// The daily absence-marking repeatable only exists from 2026-09-28; the manual
// MCP runs stopped after Sep 15, so Sep 16–27 never got marked. This one-shot
// closes that gap with the SAME service the scheduled job uses (all six guards
// apply; never-overwrite makes it idempotent).
//
// DRY RUN BY DEFAULT: `node scripts/backfill-absences-sept2026.mjs` reports.
// Pass --write to actually create the ABSENT rows.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { markAbsences } from "../src/services/absenceMarking.service.js";

const FROM = "2026-09-16";
const TO = "2026-09-27";
const WRITE = process.argv.includes("--write");

await mcpCtx.run({ system: true }, async () => {
  const tenants = (
    await prisma.employee.findMany({
      where: { tenant_id: { not: null } },
      select: { tenant_id: true },
      distinct: ["tenant_id"],
      orderBy: { tenant_id: "asc" },
    })
  ).map((e) => e.tenant_id);

  console.log(`[backfill] window ${FROM}..${TO} mode=${WRITE ? "WRITE" : "DRY-RUN"}`);
  console.log(`[backfill] tenants: ${tenants.length}`);

  let total = 0;
  for (const tenantId of tenants) {
    const summary = await markAbsences({ tenantId, from: FROM, to: TO, dryRun: !WRITE });
    total += summary.marked;
    console.log(
      `[backfill] tenant ${tenantId}: considered=${summary.employeesConsidered} ` +
        `marked=${summary.marked} alreadyPresent=${summary.alreadyPresent} ` +
        `notWorking=${summary.notWorking} manuallyCorrected=${summary.manuallyCorrected} ` +
        `skippedRotating=${summary.skippedRotating} skippedNotEmployed=${summary.skippedNotEmployed}`
    );
    if (WRITE && summary.details?.length) {
      for (const d of summary.details) {
        console.log(`[backfill]   + ABSENT ${d.employee_code ?? d.employeeId} @ ${d.date}`);
      }
    }
  }

  console.log(`[backfill] done — ${WRITE ? "created" : "would create"} ${total} ABSENT rows`);
});
process.exit(0);
