// scripts/backfill-device-enrolments.mjs — HR-ATT-DEVICE-ENROLMENT-01
//
// Seeds one open-ended enrolment per employee from today's biometric_id, then
// records the three confirmed re-enrolments.
//
// Deliberately NOT done in the migration: the equivalent INSERT ... SELECT FROM
// "Employee" in 20260904160000_hr_employment_period inserted ZERO rows and
// reported success, because Employee carries FORCE ROW LEVEL SECURITY and
// `prisma migrate deploy` runs with neither app.tenant_id nor app.tenant_bypass
// set. Inserting zero rows is not an error. A migration cannot read an RLS table.
//
// The re-enrolments, confirmed by the operator:
//
//   Afsha Khan (EMP159)    2    -> 306   from 2026-09-01   losing attendance NOW
//   Samina     (EMP224)    3021 -> 3123  from 2026-09-01   losing attendance NOW
//   Faizan Afaq(EMP178)    1    -> 500   from 2026-08-01   history only
//
// The OLD id is closed the day before the new one opens, so the two never
// overlap — an overlap is the ambiguity this model exists to remove. Old ids are
// kept rather than deleted: that is what lets a July punch under `1` still
// resolve to Faizan while a punch under `1` next year does not.
//
// Dry run unless --write.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const WRITE = process.argv.includes("--write");
const day = (d) => new Date(`${d}T00:00:00.000Z`);

// employee_code -> { oldId, newId, from }
const RE_ENROLMENTS = {
  EMP159: { oldId: "2", newId: "306", from: "2026-09-01", who: "Afsha Khan" },
  EMP224: { oldId: "3021", newId: "3123", from: "2026-09-01", who: "Samina" },
  EMP178: { oldId: "1", newId: "500", from: "2026-08-01", who: "Faizan Afaq" },
};

const SEED_FROM = "2020-01-01"; // earlier than any punch we hold

await mcpCtx.run({ system: true }, async () => {
  const employees = await prisma.employee.findMany({
    select: {
      id: true, employee_code: true, employee_name: true,
      biometric_id: true, tenant_id: true, hire_date: true,
      deviceEnrolments: {
        select: { id: true, deviceUserId: true, effectiveFrom: true, effectiveTo: true },
      },
    },
    orderBy: { employee_code: "asc" },
  });

  let seeded = 0;
  let skipped = 0;
  const reEnrolled = [];

  for (const e of employees) {
    const re = RE_ENROLMENTS[e.employee_code];
    const already = new Set(e.deviceEnrolments.map((x) => x.deviceUserId));

    // 1. The historical id. For a re-enrolled employee that is the OLD id, which
    //    biometric_id no longer holds — it already carries the new one.
    const historicId = re ? re.oldId : e.biometric_id;
    if (historicId && !already.has(String(historicId))) {
      const from = e.hire_date && e.hire_date < day(SEED_FROM) ? e.hire_date : day(SEED_FROM);
      if (WRITE) {
        await prisma.employeeDeviceEnrolment.create({
          data: {
            tenantId: e.tenant_id,
            employeeId: e.id,
            deviceUserId: String(historicId),
            effectiveFrom: from,
            // Closed the day before the new id opens; open-ended otherwise.
            effectiveTo: re ? new Date(day(re.from).getTime() - 86_400_000) : null,
            note: re
              ? `Retired id, closed when ${re.newId} took effect (HR-ATT-DEVICE-ENROLMENT-01)`
              : "Backfilled from biometric_id (HR-ATT-DEVICE-ENROLMENT-01)",
          },
        });
      }
      seeded += 1;
    } else if (!historicId) {
      skipped += 1;
    }

    // 2. The current id for a re-enrolled employee.
    if (re && !already.has(String(re.newId))) {
      if (WRITE) {
        await prisma.employeeDeviceEnrolment.create({
          data: {
            tenantId: e.tenant_id,
            employeeId: e.id,
            deviceUserId: String(re.newId),
            effectiveFrom: day(re.from),
            effectiveTo: null,
            note: `Re-enrolled from ${re.oldId} (HR-ATT-DEVICE-ENROLMENT-01)`,
          },
        });
        // Keep biometric_id in step as the convenience "current id".
        if (e.biometric_id !== re.newId) {
          await prisma.employee.updateMany({
            where: { id: e.id },
            data: { biometric_id: String(re.newId) },
          });
        }
      }
      reEnrolled.push(
        `${e.employee_code} ${re.who}: ${re.oldId} -> ${re.newId} from ${re.from}` +
          `${e.biometric_id === re.newId ? "" : `   (biometric_id ${e.biometric_id} -> ${re.newId})`}`,
      );
    }
  }

  console.log(
    `${WRITE ? "seeded" : "would seed"} ${seeded} enrolment(s); ` +
      `${skipped} employee(s) have no biometric_id`,
  );
  console.log(`re-enrolments (${reEnrolled.length}):`);
  reEnrolled.forEach((r) => console.log(`  ${r}`));

  if (WRITE) {
    const total = await prisma.employeeDeviceEnrolment.count();
    const open = await prisma.employeeDeviceEnrolment.count({ where: { effectiveTo: null } });
    console.log(`\nenrolments now: ${total}  (${open} open-ended)`);
  }
});

if (!WRITE) console.log("\nDry run. Re-run with --write to commit.");
await prisma.$disconnect().catch(() => {});
