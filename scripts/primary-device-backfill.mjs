// PRIMARY-DEVICE backfill — flag isPrimary for employees with exactly ONE
// SN-scoped, currently-in-force enrolment: that machine IS their primary.
//
// HR-ATT-PRIMARY-DEVICE-01. Deliberately conservative:
//   • employees with MULTIPLE current SN-scoped enrolments (Shah Hassan: Johar
//     9014 + Dalmia 9013) stay unflagged — which machine is primary is an HR
//     decision, made through hr_attendance_enrolment_set_primary, not guessed;
//   • null-`sn` catch-alls never become primary (they match every machine);
//   • closed periods are left as history.
//
// Idempotent and report-only by default; --apply writes.
import { Client } from "pg";

const APPLY = process.argv.includes("--apply");
const hrUrl = process.env.HR_DATABASE_URL;
if (!hrUrl) { console.error("HR_DATABASE_URL required"); process.exit(1); }

const c = new Client({ connectionString: hrUrl });
await c.connect();
await c.query("SET app.tenant_bypass = 'on'");

const candidates = await c.query(`
  WITH cur AS (
    SELECT "employeeId", count(DISTINCT "sn") AS sns, min(id) AS enrolment_id
    FROM employee_device_enrolments
    WHERE "sn" IS NOT NULL AND "sn" <> '' AND "effectiveTo" IS NULL
    GROUP BY "employeeId"
  )
  SELECT e.id AS employee_id, e.tenant_id, e.first_name, e.last_name,
         c.sns, c.enrolment_id, ee.sn AS enrolment_sn
  FROM "Employee" e
  JOIN cur c ON c."employeeId" = e.id
  JOIN employee_device_enrolments ee ON ee.id = c.enrolment_id
  ORDER BY e.tenant_id, e.id
`);

const single = candidates.rows.filter((r) => Number(r.sns) === 1);
const multi = candidates.rows.filter((r) => Number(r.sns) > 1);

console.log(`employees with current SN-scoped enrolments: ${candidates.rows.length}`);
console.log(`  single-device (auto-primary): ${single.length}`);
console.log(`  multi-device (left to HR):    ${multi.length}`);
for (const m of multi) {
  console.log(`    [multi] ${m.tenant_id?.slice(0, 8)} emp ${m.employee_id} ${m.first_name} ${m.last_name} sns=${m.sns}`);
}

if (APPLY && single.length) {
  const ids = single.map((r) => r.enrolment_id);
  // Clear first, then set — idempotent even after enrolment edits.
  await c.query("UPDATE employee_device_enrolments SET \"isPrimary\" = false WHERE \"isPrimary\" = true");
  const res = await c.query(
    `UPDATE employee_device_enrolments SET "isPrimary" = true WHERE id = ANY($1)`,
    [ids],
  );
  console.log(`APPLIED: ${res.rowCount} enrolments flagged primary`);
} else if (APPLY) {
  console.log("APPLY: nothing to flag");
}

await c.end();
