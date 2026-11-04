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
//   - Login-less row that BELONGS TO a human whose anchor already exists on
//     another row → adopts that anchor, but ONLY from LINK_LOGINLESS_ROWS
//     below (operator/HR-confirmed, with the evidence recorded next to it).
//     Name matching is never automatic.
//
// Idempotent and safe to re-run. --apply writes; default reports only. The
// script needs BOTH database URLs; in production the HR pod only has the HR
// one, so run it in a pod that carries erp-platform-credentials (for example
// deploy/prisma-studio) with:
//   HR_DATABASE_URL="$DATABASE_URL_HR" RBAC_DATABASE_URL="$DATABASE_URL_RBAC" \
//     node --input-type=module - < scripts/phaseA-personId-backfill.mjs
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
  // Operator-confirmed 2026-09-16: Akash works PECHS mornings (HomeVision row,
  // device id 200 @ TTQ5261300360) and Dalmia afternoons (JOC row, 9012 @
  // A8LN181960262). One human, two tenant rows — same person anchor.
  { first: "Akash", last: "Nanu", hrIds: [160, 554] }, // HomeVision 160 + JOC 554
];

// Login-less rows that belong to a human whose anchor already exists on
// another row. `anchorFrom` is an Employee row of the SAME human that has
// (or, in this run, gets) a personId. Evidence was read from production on
// 2026-11-05 and is kept here so the list can be re-audited later;
// `confirmedBy` is whoever signed the link off.
const LINK_LOGINLESS_ROWS = [
  {
    row: 577, // Homenet EMP-00577 "Muhammad Azeem"
    anchorFrom: 166, // HomeVision EMP166 "Muhammad Azeem Shaikh" (login 36)
    evidence: "same phone, email, date of birth and joining date",
    confirmedBy: "operator 2026-11-05",
  },
  {
    row: 594, // Homenet EMP-00505 "Shehroz Abdul Ghafoor" (Inactive)
    anchorFrom: 551, // JOC EMP-00551, same human (login 45)
    evidence: "same full name and email",
    confirmedBy: "operator 2026-11-05",
  },
  {
    row: 643, // JOC EMP-0556 "Shah Hasan Jafry"
    anchorFrom: 555, // BOC EMP-00555, same human (login 10)
    evidence: "same phone, email, device user id 9013 and joining date",
    confirmedBy: "operator 2026-11-05",
  },
  // 645 (Trusoft Live Website EMP-0001, Moeez Ahmed) needs no entry: it
  // carries its own mapping uuid -> rbac:user:17, the same login as 484.
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
  const via = byHrId.get(e.id) ? "mapping.hrEmployeeId"
    : m.uuid === sha1Uuid(`hr:employee:${e.id}`) ? "mapping.uuid" : "mapping.uuid(tenant-scoped)";
  updates.push({ emp: e, userId: m.userId, via });
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

// 5b) What the login path will write (the operator approves this list).
for (const u of updates) {
  console.log(`[anchor] ${u.emp.id} ${u.emp.employee_code} ${u.emp.first_name} ${u.emp.last_name} -> rbac:user:${u.userId} (${personAnchor(u.userId)}; ${u.via})`);
}

// 6) Login-less rows adopting an existing anchor (explicit list above).
//    Resolved after canonicalisation so a row that gains its anchor in THIS
//    run can be the source; otherwise the anchor already in the database.
const sourceIds = [...new Set(LINK_LOGINLESS_ROWS.map(l => l.anchorFrom))];
const sourceRows = (await hr.query(
  `SELECT id, employee_code, "personId" FROM "Employee" WHERE id = ANY($1::int[])`,
  [sourceIds]
)).rows;
const sourceById = new Map(sourceRows.map(r => [r.id, r]));
const links = [];
const linkSkipped = [];
for (const l of LINK_LOGINLESS_ROWS) {
  const target = emps.find(e => e.id === l.row);
  if (!target) { linkSkipped.push({ ...l, reason: "row not in the NULL-anchor set (already anchored or missing)" }); continue; }
  if (updates.some(u => u.emp.id === l.row)) { linkSkipped.push({ ...l, reason: "row already resolved by its own RBAC login" }); continue; }
  const src = sourceById.get(l.anchorFrom);
  if (!src) { linkSkipped.push({ ...l, reason: `source row ${l.anchorFrom} not found` }); continue; }
  const srcUpdate = updates.find(u => u.emp.id === l.anchorFrom);
  const anchor = srcUpdate ? personAnchor(srcUpdate.userId) : src.personId;
  if (!anchor) { linkSkipped.push({ ...l, reason: `source row ${l.anchorFrom} has no anchor` }); continue; }
  links.push({ emp: target, anchor, from: src.employee_code, reason: l.evidence });
}
for (const l of links) {
  console.log(`[link] ${l.emp.id} ${l.emp.employee_code} ${l.emp.first_name} ${l.emp.last_name} -> ${l.anchor} (from ${l.from}; ${l.reason})`);
}
for (const l of linkSkipped) console.log(`[link] ${l.row}<${l.anchorFrom} skipped: ${l.reason}`);

// 7) Write
let wrote = 0;
let linked = 0;
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
  for (const l of links) {
    const r = await hr.query(
      `UPDATE "Employee" SET "personId"=$1, updated_at=now() WHERE id=$2 AND "personId" IS NULL`,
      [l.anchor, l.emp.id]
    );
    linked += r.rowCount;
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

const linkedIds = new Set(links.map(l => l.emp.id));
const stillUnresolved = unresolved.filter(u => !linkedIds.has(u.id));
console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"}: ${updates.length} anchored, ${links.length} login-less linked, ${wrote + linked} personId written, ${rbacInt} rbac hrEmployeeId written, ${stillUnresolved.length} unresolved`);
for (const u of stillUnresolved) console.log(`  unresolved: emp ${u.id} ${u.employee_code} ${u.first_name} ${u.last_name} — ${u.reason}`);
process.exit(0);
