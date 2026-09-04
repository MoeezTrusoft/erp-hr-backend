// scripts/reresolve-by-enrolment.mjs — HR-ATT-DEVICE-ENROLMENT-01 (one-off)
//
// Re-links orphaned punches using the dated enrolments, without waiting for the
// image that carries the same logic inside resolveOrphanPunches.
//
// These rows are precisely the ones biometric_id could never resolve: a punch
// under a RETIRED id matches nobody by definition, which is why it is an orphan.
// The enrolment says who held that id at that moment — Faizan's July punches
// under `1`, Afsha's September punches under `306`, Samina's under `3123`.
//
// Both columns are corrected. Orphans carry the DEVICE's fallback tenant, and
// the employees span the fleet, so setting employeeId alone would leave a punch
// stamped to the wrong tenant, invisible to its owner under RLS.
//
// Re-linking a punch does not create attendance, so the affected days are
// re-evaluated per tenant afterwards.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { buildEnrolmentResolver } from "../src/services/deviceEnrolment.service.js";
import { applyEvaluatedShiftsForDays } from "../src/services/attendanceWriter.service.js";

const WRITE = process.argv.includes("--write");

const orphans = await mcpCtx.run({ system: true }, async () =>
  prisma.attendanceDevicePunch.findMany({
    where: { employeeId: null },
    select: { id: true, deviceUserId: true, punchedAt: true, tenantId: true },
    orderBy: { punchedAt: "asc" },
  }),
);
console.log(`orphan punches: ${orphans.length}`);

const resolveAt = await buildEnrolmentResolver(orphans.map((p) => p.deviceUserId));

const daysByTenant = new Map();
const unresolved = new Map();
let resolved = 0;
let movedTenant = 0;
const byId = new Map();

for (const p of orphans) {
  const hit = resolveAt(p.deviceUserId, p.punchedAt);
  if (!hit) {
    unresolved.set(p.deviceUserId, (unresolved.get(p.deviceUserId) ?? 0) + 1);
    continue;
  }
  resolved += 1;
  if (hit.tenantId !== p.tenantId) movedTenant += 1;
  byId.set(hit.employeeId, (byId.get(hit.employeeId) ?? 0) + 1);

  if (!daysByTenant.has(hit.tenantId)) daysByTenant.set(hit.tenantId, new Set());
  daysByTenant.get(hit.tenantId).add(p.punchedAt.toISOString().slice(0, 10));

  if (!WRITE) continue;
  await mcpCtx.run({ system: true }, async () =>
    prisma.attendanceDevicePunch.update({
      where: { id: p.id },
      data: { employeeId: hit.employeeId, tenantId: hit.tenantId },
    }),
  );
}

console.log(`resolved ${resolved}   moved tenant ${movedTenant}`);
if (byId.size) {
  const emps = await mcpCtx.run({ system: true }, async () =>
    prisma.employee.findMany({
      where: { id: { in: [...byId.keys()] } },
      select: { id: true, employee_code: true, employee_name: true },
    }),
  );
  for (const e of emps) {
    console.log(
      `  ${e.employee_code} ${String(e.employee_name).slice(0, 24).padEnd(24)} ${byId.get(e.id)} punch(es)`,
    );
  }
}
console.log(
  `still unresolved: ${[...unresolved.entries()].map(([k, n]) => `${k}(${n})`).join(", ") || "none"}`,
);

if (WRITE) {
  for (const [tid, days] of daysByTenant) {
    try {
      const res = await mcpCtx.run({ user: { tenantId: tid } }, async () =>
        applyEvaluatedShiftsForDays({
          tenantId: tid,
          days: [...days].map((d) => new Date(`${d}T00:00:00.000Z`)),
        }),
      );
      console.log(
        `  rollup ${tid.slice(0, 8)}: created=${res.created} updated=${res.updated} shifts=${res.shifts}`,
      );
    } catch (err) {
      // Punches are already re-linked and durable; one tenant failing must not
      // skip the others.
      console.log(`  rollup ${tid.slice(0, 8)} FAILED: ${err?.message}`);
    }
  }
} else {
  console.log("\nDry run. Re-run with --write to commit.");
}

await prisma.$disconnect().catch(() => {});
