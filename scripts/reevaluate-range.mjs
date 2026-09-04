// scripts/reevaluate-range.mjs — re-derive attendance for a date range.
//
//   node scripts/reevaluate-range.mjs 2026-08-01 2026-09-30 [--write]
//
// Runs the evaluator over every tenant. Days HR corrected by hand are skipped by
// the writer, so a re-run never overwrites a human ruling — only what the device
// implies. Used after a change to how punches are grouped or judged.
//
// Dry run unless --write: the writer's own dryRun flag is honoured, so a dry run
// reports what would change without touching a row.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { applyEvaluatedShifts } from "../src/services/attendanceWriter.service.js";

const args = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const from = args[0] ?? "2026-08-01";
const to = args[1] ?? "2026-09-30";
const WRITE = process.argv.includes("--write");

const TENANTS = {
  Trusoft: "40314ef4-0a81-4390-b631-b3ad3f21f523",
  Homenet: "8ff0533b-62f6-4be9-a78e-69adf49e00bc",
  EMG: "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73",
  JOC: "8f4a526f-d45b-4da2-b772-d6682e849812",
  BOC: "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2",
};

const totals = { shifts: 0, created: 0, updated: 0, unchanged: 0, skippedManuallyCorrected: 0 };

for (const [name, tenantId] of Object.entries(TENANTS)) {
  const res = await mcpCtx.run({ user: { tenantId } }, async () =>
    applyEvaluatedShifts({ tenantId, from, to, dryRun: !WRITE }),
  );
  for (const k of Object.keys(totals)) totals[k] += res[k] ?? 0;
  console.log(
    `${name.padEnd(8)} shifts=${String(res.shifts).padStart(4)} ` +
      `created=${String(res.created).padStart(3)} updated=${String(res.updated).padStart(4)} ` +
      `unchanged=${String(res.unchanged).padStart(4)} hrCorrected=${String(res.skippedManuallyCorrected).padStart(3)} ` +
      `${JSON.stringify(res.byStatus)}`,
  );
}

console.log(`\n${from} .. ${to}  ${WRITE ? "APPLIED" : "dry run"}`);
console.log(
  `  shifts ${totals.shifts}  created ${totals.created}  updated ${totals.updated}  ` +
    `unchanged ${totals.unchanged}  HR-corrected (untouched) ${totals.skippedManuallyCorrected}`,
);
if (!WRITE) console.log("\nRe-run with --write to commit.");

await prisma.$disconnect().catch(() => {});
