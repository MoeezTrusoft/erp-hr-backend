// T-P2 against Postgres: salary component changes are audited; an unchanged edit is a no-op; deleting a
// PUBLISHED component shows as an unpublished change until it is published.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, other, people, db, as } from "../approval/fixtures.mjs";
import { mcpCtx } from "../../src/mcp/context.js";
import { tenantTransaction } from "../../src/lib/rlsTenant.js";
import prisma from "../../src/lib/prisma.js";
import { createSalaryComponent, updateSalaryComponent, deleteSalaryComponent } from "../../src/services/salaryComponent.service.js";
import { publishConfig, getConfigStatus } from "../../src/services/payrollConfigActions.service.js";

let ready;
const ensure = () => (ready ||= setup());
const create = (input) => as("HR", () => createSalaryComponent({ tenantId: company, type: "EARNING", computation: "FIXED", value: 1000, ...input }));
const update = (id, input) => as("HR", () => updateSalaryComponent({ tenantId: company, id, ...input }));
const audits = (action) => db((tx) => tx.payrollAuditLog.findMany({ where: { tenantId: company, action }, orderBy: { id: "asc" } }));
const status = () => as("HR", () => getConfigStatus({ tenantId: company }));

test("components: create, edit, unchanged edit, invalid edit", { timeout: 120000 }, async () => {
  await ensure();
  const made = await create({ code: "HRA", name: "House rent" });
  assert.equal(made.status, "DRAFT");
  assert.equal(made.version, 1);
  let rows = await audits("SALARY_COMPONENT_CREATED");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oldValues, null);
  assert.equal(rows[0].newValues.code, "HRA");
  assert.equal(Number(rows[0].newValues.value), 1000);
  assert.equal(rows[0].newValues.id, made.id);

  await assert.rejects(() => create({ code: "HRA", name: "Duplicate" }), /already exists/);
  await assert.rejects(() => create({ code: "BAD", name: "Bad", type: "NOPE" }), /Invalid type/);
  assert.equal((await audits("SALARY_COMPONENT_CREATED")).length, 1, "refused creates leave no audit row");

  const edited = await update(made.id, { name: "House rent allowance", value: 1500 });
  assert.equal(edited.version, 2);
  rows = await audits("SALARY_COMPONENT_UPDATED");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oldValues.name, "House rent");
  assert.equal(rows[0].newValues.name, "House rent allowance");
  assert.equal(Number(rows[0].oldValues.value), 1000);
  assert.equal(Number(rows[0].newValues.value), 1500);
  assert.deepEqual([rows[0].oldValues.version, rows[0].newValues.version], [1, 2]);

  // Same values again: nothing changes, a PUBLISHED row stays PUBLISHED, no audit row.
  await db((tx) => tx.salaryComponent.update({ where: { id: made.id }, data: { status: "PUBLISHED" } }));
  const same = await update(made.id, { name: "House rent allowance", value: 1500, taxable: true });
  assert.equal(same.version, 2);
  assert.equal(same.status, "PUBLISHED");
  assert.equal((await audits("SALARY_COMPONENT_UPDATED")).length, 1);

  // Invalid edits are refused with no audit row and no change.
  await assert.rejects(() => update(made.id, { code: "" }), /code cannot be empty/);
  await assert.rejects(() => update(made.id, { type: "NOPE" }), /Invalid type/);
  await assert.rejects(() => update(999999999, { name: "x" }), /not found/);
  assert.equal((await audits("SALARY_COMPONENT_UPDATED")).length, 1);
  assert.equal((await db((tx) => tx.salaryComponent.findUnique({ where: { id: made.id } }))).version, 2);

  // Audit rows are append-only (X4) and invisible to another tenant.
  await assert.rejects(() => db((tx) => tx.payrollAuditLog.delete({ where: { id: rows[0].id } })), /append-only|HR-4203/);
  const seen = await mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(prisma, (tx) => tx.payrollAuditLog.count({ where: { action: { startsWith: "SALARY_COMPONENT_" } } }), { tenantId: other }),
  );
  assert.equal(seen, 0);
});

test("deleting a published component is audited and shows as an unpublished change", { timeout: 180000 }, async () => {
  await ensure();
  const comp = await create({ code: "CONV", name: "Conveyance" });
  await as("HR", () => publishConfig({ tenantId: company, publishedById: people.HR.id }));
  assert.equal((await status()).hasUnpublished, false, "everything published");

  await as("HR", () => deleteSalaryComponent({ tenantId: company, id: comp.id }));
  const del = await audits("SALARY_COMPONENT_DELETED");
  assert.equal(del.length, 1);
  assert.equal(del[0].oldValues.code, "CONV");
  assert.equal(del[0].oldValues.status, "PUBLISHED");
  assert.equal(del[0].newValues, null);
  assert.equal(await db((tx) => tx.salaryComponent.count({ where: { id: comp.id } })), 0);

  // The regression: a delete leaves no DRAFT row, so the screen said "no unpublished changes" while payroll kept
  // paying the deleted component from the last snapshot.
  assert.equal((await status()).hasUnpublished, true);
  await as("HR", () => publishConfig({ tenantId: company, publishedById: people.HR.id }));
  assert.equal((await status()).hasUnpublished, false, "publishing clears it");

  await assert.rejects(() => as("HR", () => deleteSalaryComponent({ tenantId: company, id: comp.id })), /not found/);
  assert.equal((await audits("SALARY_COMPONENT_DELETED")).length, 1, "deleting a missing component writes nothing");
});
