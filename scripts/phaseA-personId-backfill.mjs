// phaseA-personId-backfill.mjs — set Employee.personId from RBAC logins.
//
// MULTI-TENANT-EMP-01, Phase A. Employee.personId is the cross-tenant identity
// anchor (schema comment: "cross-tenant identity anchor → RBAC Person.id,
// enforced at app layer, not DB FK — cross-database"). It was NULL for all 80
// employees.
//
// Anchor definition (this script):
//   personId = uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "rbac:user:<rbacUserId>")
//   via the employee row's RBAC login found through HrEmployeeUserMapping
//   (the mapping uuid = sha1(ns || "hr:employee:<hrEmployeeId>")).
//
//   - One employee-row with a login → its own deterministic anchor.
//   - Dual-tenant human (e.g. Shah Hassan: HR 549 JOC + 555 BOC) → BOTH rows
//     get the anchor of the CANONICAL login (lowest RBAC user id among the
//     human's logins), so the two rows share one person identity. This is the
//     cross-tenant link required by MULTI-TENANT-EMP-01.
//   - No login → stays NULL (never mint a fake identity).
//
// Idempotent and safe to re-run. --apply writes; default reports only.
import crypto from "node:crypto";
import { Client } from "pg";

const NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const APPLY = process.argv.includes("--apply");

// Explicit, operator-confirmed dual-tenant humans ONLY. Name auto-matching is
// deliberately NOT used: two different people can share a name, and merging
// their identities would be a silent data-integrity breach. Add a human here
// only after HR confirms the rows belong to one person.
const DUAL_TENANT_HUMANS = [
  { first: "Shah Hassan", last: "Jafry", hrIds: [549, 555] }, // JOC 549 + BOC 555
];

const hrUrl = process.env.HR_DATABASE_URL;
const rbacUrl = process.env.RBAC_DATABASE_URL;
if (!hrUrl || !rbacUrl) {
  console.error("HR_DATABASE_URL and RBAC_DATABASE_URL required");
  process.exit(1);
}

const sha1Uuid = (name) => {
  const h = crypto.createHash("sha1");
  h.update(Buffer.from(NS.replace(/-/g, ""), "hex"));
  h.update(Buffer.from(name, "utf8"));
  const b = h.digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const personAnchor = (rbacUserId) => sha1Uuid(`rbac:user:${rbacUserId}`);

const hr = new Client({ connectionString: hrUrl });
const rbac = new Client({ connectionString: rbacUrl });
await hr.connect();
await rbac.connect();
// FORCE-RLS: the app role sees ZERO rows without the fleet-bypass GUC — the
// script is fleet-wide by definition (it spans every tenant), same as intake.
// NOTE the two databases use DIFFERENT GUC names: HR reads app.tenant_bypass,
// RBAC reads app.company_bypass (see rls-company.js).
await hr.query("SET app.tenant_bypass = 'on'");
await rbac.query("SET app.company_bypass = 'on'");

// 1) All employee rows that need an anchor
const emps = (await hr.query(
  `SELECT id, tenant_id, employee_code, first_name, last_name FROM "Employee" WHERE "personId" IS NULL ORDER BY id`
)).rows;
console.log(`employees without personId: ${emps.length}`);

// 2) RBAC logins: mapping uuid -> (userId, tenant)
const maps = (await rbac.query(
  `SELECT "employeeId" AS uuid, "hrEmployeeId", "userId", "tenantId" FROM "HrEmployeeUserMapping"`
)).rows;

// 3) Map HR row -> login(s)
const byHrId = new Map(maps.filter(m => m.hrEmployeeId != null).map(m => [m.hrEmployeeId, m]));
const byUuid = new Map(maps.map(m => [m.uuid, m]));
// Two historical uuid derivations exist: the bulk provisioning script used
// sha1(ns || "hr:employee:<id>") while rbac_employee_create used the outbox
// format sha1(ns || "hr:employee:<tenantId>:<id>"). Try both.
const byUuid2 = new Map();
for (const e of emps) byUuid2.set(sha1Uuid(`hr:employee:${e.tenant_id}:${e.id}`), e.id);
const byEmpFromAlt = new Map();
for (const m of maps) {
  for (const [uuid, empId] of byUuid2) {
    if (m.uuid === uuid) byEmpFromAlt.set(empId, m);
  }
}

const updates = [];
const unresolved = [];
for (const e of emps) {
  const m = byHrId.get(e.id)
    ?? byUuid.get(sha1Uuid(`hr:employee:${e.id}`))
    ?? byEmpFromAlt.get(e.id);
  if (!m) { unresolved.push({ ...e, reason: "no RBAC login" }); continue; }
  updates.push({ emp: e, userId: m.userId });
}

// 5) Canonicalise ONLY the explicit dual-tenant humans: every confirmed row of
// one person shares the anchor of their canonical (lowest-id) login.
for (const human of DUAL_TENANT_HUMANS) {
  const group = updates.filter(u => human.hrIds.includes(u.emp.id));
  if (group.length < 2) {
    console.log(`[dual-tenant] ${human.first} ${human.last}: only ${group.length} row(s) found — skipped`);
    continue;
  }
  const canonical = Math.min(...group.map(u => u.userId));
  for (const u of group) u.userId = canonical;
  console.log(`[dual-tenant] ${human.first} ${human.last}: ${group.map(u => u.emp.id).join("+")} -> canonical rbac:user:${canonical}`);
}

// 6) Write
let wrote = 0;
let rbacInt = 0;
if (APPLY) {
  await hr.query("BEGIN");
  for (const u of updates) {
    const anchor = personAnchor(u.userId);
    const r = await hr.query(
      `UPDATE "Employee" SET "personId"=$1, updated_at=now() WHERE id=$2 AND "personId" IS NULL`,
      [anchor, u.emp.id]
    );
    wrote += r.rowCount;
  }
  await hr.query("COMMIT");

  // MULTI-TENANT-EMP-01 (RBAC side): each mapping row learns its tenant's
  // integer Employee.id, computed here from the HR side (the mapping uuid is
  // one-way sha1, so SQL cannot invert it). The session builder reads this on
  // every login to resolve the access-token employeeId per tenant.
  for (const u of updates) {
    const uuid = sha1Uuid(`hr:employee:${u.emp.id}`);
    const r = await rbac.query(
      `UPDATE "HrEmployeeUserMapping" SET "hrEmployeeId"=$1, "updatedAt"=now()
       WHERE "employeeId"=$2 AND "hrEmployeeId" IS NULL`,
      [u.emp.id, uuid]
    );
    rbacInt += r.rowCount;
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"}: ${updates.length} anchored, ${wrote} personId written, ${rbacInt} rbac hrEmployeeId written, ${unresolved.length} unresolved`);
for (const u of unresolved) console.log(`  unresolved: emp ${u.id} ${u.employee_code} ${u.first_name} ${u.last_name} — ${u.reason}`);
process.exit(0);
