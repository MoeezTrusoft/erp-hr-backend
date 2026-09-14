// scripts/attendance-backfill-window.js
//
// Backfill a window of Attendance rows from device punches through the
// EVALUATOR (applyEvaluatedShifts) — the same code path the live intake uses,
// so a backfilled month cannot drift from what ingestion would have written.
//
//   node scripts/attendance-backfill-window.js --from 2026-09-01 --to 2026-09-08           # DRY RUN
//   node scripts/attendance-backfill-window.js --from 2026-09-01 --to 2026-09-08 --write   # REAL
//
// Dry-run first is non-negotiable: this rewrites days that feed pay.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { applyEvaluatedShifts } from "../src/services/attendanceWriter.service.js";
import { tenantsWithPunches } from "../src/lib/attendanceReplay.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM = arg("from", "2026-09-01");
const TO = arg("to", "2026-09-08");
const WRITE = process.argv.includes("--write");

async function main() {
  const tenantIds = await tenantsWithPunches(mcpCtx);
  const run = WRITE ? "REAL WRITE" : "DRY RUN";
  console.log(`\n=== attendance backfill ${FROM} → ${TO} — ${run} ===`);

  const grand = { shifts: 0, created: 0, updated: 0, unchanged: 0, held: 0, skippedManuallyCorrected: 0 };

  for (const tenantId of tenantIds) {
    await mcpCtx.run({ user: { tenantId } }, async () => {
      const summary = await applyEvaluatedShifts({ tenantId, from: FROM, to: TO, dryRun: !WRITE });
      console.log(
        `\ntenant ${tenantId}\n` +
        `  shifts=${summary.shifts} created=${summary.created} updated=${summary.updated} ` +
        `unchanged=${summary.unchanged} retracted=${summary.retracted} nonWorking=${summary.nonWorking} ` +
        `held(missing_*)=${summary.held} manualCorrected(skipped)=${summary.skippedManuallyCorrected}`
      );
      const byStatus = Object.entries(summary.byStatus)
        .map(([k, v]) => `${k}:${v}`)
        .join("  ");
      console.log(`  byStatus: ${byStatus || "(none)"}`);
      grand.shifts += summary.shifts;
      grand.created += summary.created;
      grand.updated += summary.updated;
      grand.unchanged += summary.unchanged;
      grand.held += summary.held;
      grand.skippedManuallyCorrected += summary.skippedManuallyCorrected;
    });
  }

  console.log(`\n=== GRAND TOTAL (${run}) ===`);
  console.log(JSON.stringify(grand, null, 2));
  if (!WRITE) console.log("\nDry run only — re-run with --write to apply.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
