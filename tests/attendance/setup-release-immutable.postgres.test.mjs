// T1 against Postgres: a published attendance setup can be added but never edited or removed.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, db } from "../approval/fixtures.mjs";

const refused = (fn, msg) => assert.rejects(fn, (e) => /HR-4203|append-only/.test(String(e?.message ?? e)), msg);

test("attendance setup releases are append-only", { timeout: 120000 }, async () => {
  await setup();
  const mk = (version) =>
    db((tx) =>
      tx.attendanceSetupRelease.create({
        data: { tenantId: company, version, effectiveFrom: new Date("2026-10-01"), coverageThrough: new Date("2026-10-31"), config: { graceMinutes: 10 }, reason: "initial", publishedById: null },
      }),
    );
  const r1 = await mk(100); // the fixtures already publish low versions
  const r2 = await mk(101); // adding a later version still works
  assert.equal(r2.version, 101);

  await refused(() => db((tx) => tx.attendanceSetupRelease.update({ where: { id: r1.id }, data: { config: { graceMinutes: 999 } } })), "config rewrite");
  await refused(() => db((tx) => tx.attendanceSetupRelease.update({ where: { id: r1.id }, data: { reason: "changed" } })), "reason rewrite");
  await refused(() => db((tx) => tx.attendanceSetupRelease.update({ where: { id: r1.id }, data: { effectiveFrom: new Date("2026-01-01") } })), "effective date shift");
  await refused(() => db((tx) => tx.attendanceSetupRelease.delete({ where: { id: r1.id } })), "delete");
  await refused(() => db((tx) => tx.attendanceSetupRelease.deleteMany({ where: { tenantId: company } })), "bulk delete");

  const still = await db((tx) => tx.attendanceSetupRelease.findUnique({ where: { id: r1.id } }));
  assert.equal(still.config.graceMinutes, 10);
  assert.equal(still.reason, "initial");
  assert.equal(await db((tx) => tx.attendanceSetupRelease.count({ where: { tenantId: company, version: { gte: 100 } } })), 2);

  // A duplicate version is still rejected by the unique key (the guard does not hide it).
  await assert.rejects(() => mk(101), /Unique|unique|P2002/);
});
