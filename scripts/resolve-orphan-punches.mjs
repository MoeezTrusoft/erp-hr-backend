// scripts/resolve-orphan-punches.mjs — HR-ATT-ORPHAN-RESOLVE-01
//
// Re-link device punches that stored unresolved and can be resolved now, then
// re-evaluate the days they land on so the attendance actually appears.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { resolveOrphanPunches } from "../src/services/attendance.device-intake.service.js";

const dryRun = !process.argv.includes("--write");
const summary = await resolveOrphanPunches({ dryRun });

console.log(`scanned          ${summary.scanned}`);
console.log(`resolved         ${summary.resolved}`);
console.log(`moved tenant     ${summary.movedTenant}`);
console.log(
  `still unresolved ${summary.stillUnresolved.length} -> ${summary.stillUnresolved.join(", ") || "(none)"}`,
);
for (const [tid, res] of Object.entries(summary.rollup)) {
  console.log(`  rollup ${tid.slice(0, 8)}: ${JSON.stringify(res)}`);
}
if (dryRun) console.log("\nDry run. Re-run with --write to commit.");

await prisma.$disconnect().catch(() => {});
process.exit(0);
