// Tax slabs against PostgreSQL: a country's whole slab set is replaced by a request that the payroll approval route
// approves. Nothing changes while it waits, rejection changes nothing, the slabs in force are ended the day before the
// new set starts (so past payroll keeps its slabs), and a date a payroll run already covers is refused.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { company, other, people, db, as, act, ensure, approvalOf } from "../attendance/route-fixture.mjs";
const svc = await import("../../src/services/taxSlabChangeRequest.service.js");
const { selectEffectiveTaxRates } = await import("../../src/services/payrollService.js");
const matrix = await import("../../src/services/approvalMatrix.service.js");
const { mcpCtx } = await import("../../src/mcp/context.js");

const hr = (fn) => as("BOTH", fn);
const asker = () => ({ tenantId: company, requestedById: people.BOTH.id });
const SET_A = [{ upto: 50000, ratePct: 0 }, { upto: 100000, ratePct: 1 }, { upto: 200000, ratePct: 11 }, { ratePct: 20 }];
const SET_B = [{ upto: 60000, ratePct: 0 }, { upto: 150000, ratePct: 5 }, { ratePct: 25 }];
const ask = (over = {}) => hr(() => svc.requestTaxSlabSet({ ...asker(), countryCode: "PK", effectiveFrom: "2031-07-01", slabs: SET_A, reason: "New fiscal year slabs", ...over }));
const rows = (tenantId = company) => db((tx) => tx.taxRate.findMany({ where: { tenantId, countryCode: "PK" }, orderBy: [{ effectiveFrom: "asc" }, { bracketMin: "asc" }] }));
const level = (name, action, who) => ({ name, action, approverMode: "NAMED", approverIds: [people[who].id] });
const tenantCtx = (fn) => mcpCtx.run({ user: { tenantId: company } }, fn);
const publishPayrollRoute = async () => {
  await tenantCtx(() => matrix.saveApprovalMatrixDraft({ tenantId: company, actorId: "t", kind: "PAYROLL", levels: [level("HR check", "VERIFY", "HR"), level("Management", "APPROVE", "MANAGEMENT")] }));
  await tenantCtx(() => matrix.publishApprovalMatrix({ tenantId: company, actorId: "t", kind: "PAYROLL", reason: "tax slab tests" }));
};
let routed;
const route = () => (routed ||= publishPayrollRoute());
const decide = async (id, finalAction = "APPROVE") => {
  const ar = await approvalOf("TAX_SLAB_CHANGE", id);
  assert.ok(ar, "the request reached the Approval Centre");
  const rec = await act("HR", { approvalRef: ar.id, version: ar.version }, "VERIFY");
  return act("MANAGEMENT", rec, finalAction);
};
// The Prisma client is scoped to one company, so another company's rows are read through the admin connection.
const admin = async (sql, args = []) => {
  const client = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
  await client.connect();
  try {
    return (await client.query(sql, args)).rows;
  } finally {
    await client.end();
  }
};
const otherRows = () => admin('SELECT id, "effectiveTo", status FROM tax_rates WHERE "tenantId" = $1 ORDER BY id', [other]);
const seedCurrent = () =>
  db(async (tx) => {
    await tx.taxRate.deleteMany({ where: { tenantId: company } });
    for (const [i, s] of SET_B.entries())
      await tx.taxRate.create({ data: { tenantId: company, countryCode: "PK", bracketMin: i ? SET_B[i - 1].upto : 0, bracketMax: s.upto ?? null, rate: s.ratePct / 100, baseTax: 0, status: "ACTIVE", effectiveFrom: new Date("2026-07-01") } });
  });

test("a slab change needs the payroll route, a reason, a country, a date and a valid ladder; nothing is left behind", async () => {
  await ensure();
  await seedCurrent();
  await assert.rejects(ask(), /Publish the payroll approval route/);
  assert.equal(await db((tx) => tx.taxSlabChangeRequest.count({ where: { tenantId: company } })), 0, "no orphan request");
  await route();
  await assert.rejects(ask({ reason: " " }), /reason/i);
  await assert.rejects(ask({ countryCode: "Pakistan" }), /country/i);
  await assert.rejects(ask({ effectiveFrom: "next July" }), /YYYY-MM-DD/);
  await assert.rejects(ask({ effectiveFrom: "2031-02-31" }), /YYYY-MM-DD/);
  await assert.rejects(ask({ slabs: [] }), /at least one/i);
  await assert.rejects(ask({ slabs: [{ upto: 100, ratePct: 5 }, { upto: 50, ratePct: 5 }, { ratePct: 9 }] }), /upper limit must be above/);
  await assert.rejects(ask({ slabs: [{ upto: 100, ratePct: 5 }] }), /last slab has no upper limit/);
  await assert.rejects(ask({ slabs: [{ upto: 100, ratePct: 5 }, { upto: 200, ratePct: 7 }] }), /last slab has no upper limit/);
  await assert.rejects(ask({ slabs: [{ ratePct: 5 }, { ratePct: 7 }] }), /needs an upper limit/);
  await assert.rejects(ask({ slabs: [{ upto: 100, ratePct: 101 }, { ratePct: 9 }] }), /between 0 and 100/);
  await assert.rejects(ask({ slabs: [{ upto: 100, ratePct: -1 }, { ratePct: 9 }] }), /between 0 and 100/);
  await assert.rejects(hr(() => svc.requestTaxSlabSet({ ...asker(), requestedById: null, effectiveFrom: "2031-07-01", slabs: SET_A, reason: "x y z" })), /employee account/);
  await assert.rejects(ask().then(() => ask({ effectiveFrom: "2031-08-01" })), /already has a tax slab change waiting/).finally(async () => {
    const waiting = await db((tx) => tx.taxSlabChangeRequest.findMany({ where: { tenantId: company, status: "PENDING" } }));
    for (const w of waiting) await decide(w.id, "REJECT");
  });
  assert.equal((await rows()).length, 3, "the slabs in force were never touched");
});

test("the slabs in force are not a change", async () => {
  await ensure();
  await route();
  await seedCurrent();
  await assert.rejects(ask({ slabs: SET_B, effectiveFrom: "2031-07-01" }), /already in force/);
});

test("nothing changes while the request waits; the final approval ends the old slabs the day before and adds the new set", async () => {
  await ensure();
  await route();
  await seedCurrent();
  const before = await rows();
  const filed = await ask();
  assert.equal(filed.pendingApproval, true);
  assert.deepEqual((await rows()).map((r) => r.id), before.map((r) => r.id), "waiting changes nothing");
  const waiting = await hr(() => svc.listPendingTaxSlabChanges({ tenantId: company }));
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0].requestedByName);
  assert.match(waiting[0].payload.changes[0], /PK income-tax slabs from 2031-07-01/);

  assert.equal((await decide(filed.requestId)).stage, "APPROVED");
  const after = await rows();
  const old = after.filter((r) => +new Date(r.effectiveFrom) === +new Date("2026-07-01"));
  const fresh = after.filter((r) => +new Date(r.effectiveFrom) === +new Date("2031-07-01"));
  assert.equal(old.length, 3);
  assert.ok(old.every((r) => r.effectiveTo && r.effectiveTo.toISOString().slice(0, 10) === "2031-06-30"), "ended the day before");
  assert.equal(fresh.length, 4);
  assert.deepEqual(fresh.map((r) => [Number(r.bracketMin), r.bracketMax == null ? null : Number(r.bracketMax), Number(r.rate)]), [[0, 50000, 0], [50000, 100000, 0.01], [100000, 200000, 0.11], [200000, null, 0.2]]);
  assert.deepEqual(fresh.map((r) => Number(r.baseTax)), [0, 0, 500, 11500], "base tax is worked out, not typed");

  // Payroll before the start date still uses the old slabs; after it, the new ones.
  const pick = (asOf) => selectEffectiveTaxRates(after, { countryCode: "PK", asOf: new Date(asOf) }).length;
  assert.equal(pick("2031-06-30"), 3);
  assert.equal(pick("2031-07-01"), 4);
  const audit = await db((tx) => tx.payrollAuditLog.findFirst({ where: { tenantId: company, action: "TAX_SLAB_CHANGE_APPLIED" }, orderBy: { id: "desc" } }));
  assert.ok(audit, "the change is audited");
});

test("a rejected request changes nothing and another company's slabs are never touched", async () => {
  await ensure();
  await route();
  await seedCurrent();
  await admin('DELETE FROM tax_rates WHERE "tenantId" = $1', [other]);
  await admin(`INSERT INTO tax_rates ("tenantId", "countryCode", "bracketMin", "bracketMax", rate, "baseTax", status, "effectiveFrom", updated_at) VALUES ($1, 'PK', 0, NULL, 0.1, 0, 'ACTIVE', '2026-07-01', now())`, [other]);
  const foreignBefore = await otherRows();
  assert.equal(foreignBefore.length, 1, "the other company has its own slab");
  const before = (await rows()).length;
  const filed = await ask({ effectiveFrom: "2032-07-01" });
  assert.equal((await decide(filed.requestId, "REJECT")).stage, "REJECTED");
  assert.equal((await rows()).length, before, "a rejected request changes nothing");
  const filedAgain = await ask({ effectiveFrom: "2032-07-01" });
  await decide(filedAgain.requestId);
  assert.deepEqual(await otherRows(), foreignBefore, "the other company's slabs are exactly as they were");
  await admin('DELETE FROM tax_rates WHERE "tenantId" = $1', [other]);
});

test("a date a payroll run already covers is refused, when filing and again at the final approval", async () => {
  await ensure();
  await route();
  await seedCurrent();
  const run = await db((tx) => tx.payrollRun.create({ data: { tenantId: company, processedBy: people.HR.id, periodStart: new Date("2033-06-01T00:00:00Z"), periodEnd: new Date("2033-06-30T00:00:00Z"), countryCode: "PK", currencyCode: "PKR", status: "COMPLETED", totalGross: 1, totalNet: 1 } }));
  try {
    await assert.rejects(ask({ effectiveFrom: "2033-06-15" }), /payroll run already covers/);
    await assert.rejects(ask({ effectiveFrom: "2033-06-30" }), /payroll run already covers/, "the last day of the run counts");
    const filed = await ask({ effectiveFrom: "2033-07-01" });
    await db((tx) => tx.payrollRun.update({ where: { id: run.id }, data: { periodEnd: new Date("2033-07-31T00:00:00Z") } }));
    const before = await rows();
    const ar = await approvalOf("TAX_SLAB_CHANGE", filed.requestId);
    const verified = await act("HR", { approvalRef: ar.id, version: ar.version }, "VERIFY");
    await assert.rejects(act("MANAGEMENT", verified, "APPROVE"), /payroll run already covers/);
    assert.deepEqual((await rows()).map((r) => r.id), before.map((r) => r.id), "a refused approval changes nothing");
    await db((tx) => tx.payrollRun.update({ where: { id: run.id }, data: { status: "CANCELLED" } }));
    const again = await approvalOf("TAX_SLAB_CHANGE", filed.requestId);
    assert.equal((await act("MANAGEMENT", { approvalRef: again.id, version: again.version }, "APPROVE")).stage, "APPROVED", "a cancelled run no longer blocks it");
  } finally {
    await db((tx) => tx.payrollRun.delete({ where: { id: run.id } }));
  }
});

test("a set that starts on or before slabs already scheduled replaces them", async () => {
  await ensure();
  await route();
  await seedCurrent();
  const first = await ask({ effectiveFrom: "2034-07-01" });
  await decide(first.requestId);
  const second = await ask({ effectiveFrom: "2034-01-01", slabs: SET_B.map((s) => ({ ...s, ratePct: s.ratePct + 1 })) });
  await decide(second.requestId);
  const all = await rows();
  const scheduled = all.filter((r) => +new Date(r.effectiveFrom) === +new Date("2034-07-01"));
  assert.ok(scheduled.every((r) => r.status === "INACTIVE"), "the later scheduled set is superseded");
  const at = (d) => selectEffectiveTaxRates(all, { countryCode: "PK", asOf: new Date(d) }).map((r) => Number(r.rate));
  assert.deepEqual(at("2034-08-01"), [0.01, 0.06, 0.26], "the newest set is the one in force");
});
