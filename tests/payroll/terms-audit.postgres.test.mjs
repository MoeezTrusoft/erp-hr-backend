// X4 against Postgres: creating salary terms always leaves an audit row with old and new amounts.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, other, people, db, as } from "../approval/fixtures.mjs";
import { mcpCtx } from "../../src/mcp/context.js";
import { tenantTransaction } from "../../src/lib/rlsTenant.js";
import prisma from "../../src/lib/prisma.js";
import { createEmploymentTerms } from "../../src/services/payrollService.js";
import { termsSnapshot } from "../../src/lib/termsAudit.js";

const terms = (employeeId, baseSalary, effectiveFrom) => ({ employeeId, baseSalary, currency: "PKR", payFrequency: "MONTHLY", effectiveFrom: new Date(effectiveFrom) });
const auditFor = (employeeId) =>
  db((tx) => tx.payrollAuditLog.findMany({ where: { tenantId: company, employeeId, action: "EMPLOYMENT_TERMS_CREATED" }, orderBy: { id: "asc" } }));

test("salary terms create writes an audit row with previous and new amounts", { timeout: 120000 }, async () => {
  await setup();
  const emp = people.EMPLOYEE.id;

  await as("HR", () => createEmploymentTerms(terms(emp, 100000, "2026-09-01"), people.HR.id, company));
  let rows = await auditFor(emp);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oldValues, null, "first terms have no previous");
  assert.equal(Number(rows[0].newValues.salary), 100000);
  assert.equal(rows[0].newValues.currency, "PKR");
  assert.equal(rows[0].newValues.effectiveFrom, "2026-09-01");

  await as("HR", () => createEmploymentTerms(terms(emp, 120000.5, "2026-10-01"), people.HR.id, company));
  rows = await auditFor(emp);
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[1].oldValues.salary), 100000, "previous amount recorded");
  assert.equal(Number(rows[1].newValues.salary), 120000.5, "fraction kept");
  assert.equal(rows[1].employeeId, emp);

  // A backdated record compares against the latest EFFECTIVE terms, not the last typed.
  await as("HR", () => createEmploymentTerms(terms(emp, 90000, "2026-08-01"), people.HR.id, company));
  rows = await auditFor(emp);
  assert.equal(rows[2].oldValues.effectiveFrom, "2026-10-01");

  // A failed create leaves no audit row behind (same transaction).
  await assert.rejects(() => as("HR", () => createEmploymentTerms({ employeeId: emp, currency: "PKR" }, people.HR.id, company)));
  assert.equal((await auditFor(emp)).length, 3);

  // Another tenant (really running as that tenant) sees none of these rows.
  const seen = await mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(prisma, (tx) => tx.payrollAuditLog.count({ where: { action: "EMPLOYMENT_TERMS_CREATED" } }), { tenantId: other }),
  );
  assert.equal(seen, 0);
});

test("termsSnapshot: odd inputs", () => {
  assert.equal(termsSnapshot({ baseSalary: "abc" }).salary, null);
  assert.equal(termsSnapshot({ baseSalary: 1 / 3 }).salary, "0.3333", "4dp as stored");
  assert.equal(termsSnapshot({ baseSalary: null }).salary, "0.0000");
  assert.equal(termsSnapshot({}).effectiveFrom, null);
  assert.equal(termsSnapshot({ effectiveFrom: "not a date" }).effectiveFrom, null, "bad date never throws");
});
