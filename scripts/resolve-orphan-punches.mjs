// Bounded tenant recovery; original evidence is preserved. The worker evaluates
// resolved receipts. Safe preview by default; no current biometric-ID fallback.
import prisma from "../src/lib/prisma.js";
import {
  resolveOrphanPunches,
  bridgeLegacyOrphans,
} from "../src/services/attendance.device-intake.service.js";
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const tenantId = args.includes("--tenant") ? value("--tenant") : null;
if (!tenantId)
  throw new Error("Use --tenant <UUID> [--after <event-id>] [--write]");
try {
  const recover = args.includes("--legacy")
    ? bridgeLegacyOrphans
    : resolveOrphanPunches;
  const cursor = args.includes("--after") ? value("--after") : undefined;
  const result = await recover({
    tenantId,
    dryRun: !args.includes("--write"),
    afterId: args.includes("--legacy") ? Number(cursor || 0) : cursor,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}
