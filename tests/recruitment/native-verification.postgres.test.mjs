import { nativeVerificationEntryLifecycle } from "../../src/services/native-verification-lifecycle.service.js";
import {
  enqueueEmployeeLifecycle,
  mapEmployeeToLifecycleInput,
} from "../../src/services/employeeOutbox.service.js";
import { nativeVerificationEntryStatus } from "../../src/services/native-verification-status.service.js";
// Requires a fresh, migrated, restricted Kubernetes loopback PostgreSQL fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { nativeFixture } from "../fixtures/native-verification.js";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Isolated recruitment database required");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 27).toString("base64");
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { prepareEmployeeInsert } = await import("../../src/services/employee-code.service.js");
const { updateEmployeeStatus } = await import("../../src/services/hrContract.service.js");
const { buildSystemAccountProvisioningIntent } =
  await import("../../src/jobs/system-account-provisioning.js");
const { lockNativeHrGrant, findNativeHrReplay, bindNativeHrIntent, withNativeHrWorkerClaim } =
  await import("../../src/services/native-verification-guard.service.js");
const { applyHrNativeGrant, nativeRbacReceiptFingerprint } =
  await import("../../scripts/native-verification-grant.mjs");
const as = (f, fn) => mcpCtx.run(f.ctx, fn);
const transact = (f, fn) =>
  as(f, () =>
    tenantTransaction(db, fn, { tenantId: f.plan.tenantId, txOptions: { timeout: 30000 } }),
  );
const fresh = () => nativeFixture(new Date(), randomBytes(4).toString("hex"));
const controller = (f) => ({
  plan: f.plan,
  dispatch: {
    operation: "INSTALL",
    planFingerprint: f.authorization.fingerprint,
    operationRef: "test:controller:install:20261023",
    dispatch: f.plan.operatorOrigin,
    rbacAuthorization: {
      id: "123",
      fingerprint: nativeRbacReceiptFingerprint(f.plan, "BOOTSTRAP_AUTHORIZATION", "123"),
    },
    rbacCancellation: null,
  },
});
const install = (f) =>
  as(f, () => applyHrNativeGrant({ prisma: db, transaction: tenantTransaction }, controller(f)));
const createOwned = (f, { failAfterBind = false } = {}) =>
  transact(f, async (tx) => {
    await lockNativeHrGrant(tx, f.authorization);
    const replay = await findNativeHrReplay(tx, f.authorization);
    if (replay) return replay;
    const data = await prepareEmployeeInsert(
      tx,
      {
        first_name: f.entry.firstName,
        last_name: f.entry.lastName,
        work_email: f.entry.email,
        status: "Active",
        employement_status: "Active",
      },
      { tenantId: f.plan.tenantId, category: "EMPLOYEE" },
    );
    const employee = await tx.employee.create({ data });
    const intentData = buildSystemAccountProvisioningIntent(
      { ...f.data, hireDate: new Date(f.data.hireDate) },
      employee,
      { tenantId: f.plan.tenantId },
    );
    const systemAccount = await tx.systemAccountProvisioning.create({ data: intentData });
    await bindNativeHrIntent(tx, f.authorization, employee, systemAccount);
    // Use the actual producer in this isolated fixture transaction. This is not
    // a live dispatch/consumer receipt or a substitute for cross-service acceptance.
    await enqueueEmployeeLifecycle(tx, {
      ...mapEmployeeToLifecycleInput(employee, "hired"),
      aggregateId: employee.id,
      actorId: f.plan.bootstrap.userId,
    });
    if (failAfterBind) throw new Error("synthetic rollback");
    return { employee, systemAccount };
  });
const cancel = (f) =>
  as(f, () =>
    applyHrNativeGrant(
      { prisma: db, transaction: tenantTransaction, updateEmployeeStatus },
      {
        ...controller(f),
        dispatch: {
          ...controller(f).dispatch,
          operation: "CANCEL",
          operationRef: "test:controller:cancel:20261023",
          rbacCancellation: {
            id: "124",
            grantId: f.plan.grantId,
            fingerprint: nativeRbacReceiptFingerprint(f.plan, "BOOTSTRAP_CANCELLED", "124", "123"),
          },
        },
      },
    ),
  );

test("native verification durable ownership and cancellation", async (t) => {
  t.after(() => db.$disconnect());
  const f = fresh();
  await t.test(
    "a public plan without a controller-installed receipt cannot create an employee",
    async () => {
      await assert.rejects(createOwned(f), /HR-0310/);
    },
  );
  await install(f);
  let owned;
  await t.test(
    "parallel identical creates bind exactly one actual employee and intent",
    async () => {
      const results = await Promise.all([createOwned(f), createOwned(f), createOwned(f)]);
      assert.equal(new Set(results.map((row) => row.employee.id)).size, 1);
      assert.equal(new Set(results.map((row) => row.systemAccount.id)).size, 1);
      owned = results[0];
      assert.equal(
        await transact(f, (tx) =>
          tx.nativeVerificationEntry.count({ where: { grantId: f.plan.grantId } }),
        ),
        1,
      );
    },
  );
  await t.test(
    "bootstrap observation returns exactly its owned pending identity without mutating the intent",
    async () => {
      const before = await transact(f, (tx) =>
        tx.systemAccountProvisioning.findFirstOrThrow({ where: { id: owned.systemAccount.id } }),
      );
      const result = await as(f, () =>
        nativeVerificationEntryStatus(
          { entryId: f.entry.entryId },
          { db, loadPlan: async () => f.plan },
        ),
      );
      assert.deepEqual(
        Object.keys(result).sort(),
        [
          "grantId",
          "entryId",
          "employeeId",
          "provisioningId",
          "idempotencyKey",
          "payloadFingerprint",
          "status",
          "rbacUserId",
        ].sort(),
      );
      assert.equal(result.employeeId, owned.employee.id);
      assert.equal(result.provisioningId, owned.systemAccount.id);
      assert.equal(result.status, "PENDING");
      assert.equal(result.rbacUserId, null);
      const after = await transact(f, (tx) =>
        tx.systemAccountProvisioning.findFirstOrThrow({ where: { id: owned.systemAccount.id } }),
      );
      assert.deepEqual(after, before);
    },
  );
  await t.test(
    "observation reflects authoritative states and only a canonical stored successful ID",
    async () => {
      for (const status of ["PROCESSING", "RETRY_WAIT", "TERMINAL_FAILED", "SUCCEEDED"]) {
        await transact(f, (tx) =>
          tx.systemAccountProvisioning.update({
            where: { id: owned.systemAccount.id },
            data: {
              status,
              rbacUserId: status === "SUCCEEDED" ? "7101" : null,
              lastError: "SYNTHETIC_PRIVATE_ERROR",
            },
          }),
        );
        const result = await as(f, () =>
          nativeVerificationEntryStatus(
            { entryId: f.entry.entryId },
            { db, loadPlan: async () => f.plan },
          ),
        );
        assert.equal(result.status, status);
        assert.equal(result.rbacUserId, status === "SUCCEEDED" ? "7101" : null);
        assert.ok(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_ERROR"));
      }
      await transact(f, (tx) =>
        tx.systemAccountProvisioning.update({
          where: { id: owned.systemAccount.id },
          data: { status: "SUCCEEDED", rbacUserId: null },
        }),
      );
      await assert.rejects(
        as(f, () =>
          nativeVerificationEntryStatus(
            { entryId: f.entry.entryId },
            { db, loadPlan: async () => f.plan },
          ),
        ),
        /HR-0310/,
      );
      await transact(f, (tx) =>
        tx.systemAccountProvisioning.update({
          where: { id: owned.systemAccount.id },
          data: { status: "PENDING", rbacUserId: null, lastError: null },
        }),
      );
    },
  );
  await t.test(
    "observation denies foreign context, another planned entry, arbitrary selectors and expiry",
    async () => {
      const foreignCtx = { ...f.ctx, user: { ...f.ctx.user, tenantId: randomUUID() } };
      await assert.rejects(
        mcpCtx.run(foreignCtx, () =>
          nativeVerificationEntryStatus(
            { entryId: f.entry.entryId },
            { db, loadPlan: async () => f.plan },
          ),
        ),
        /HR-0310/,
      );
      await assert.rejects(
        as(f, () =>
          nativeVerificationEntryStatus(
            { entryId: f.plan.accounts[1].entryId },
            { db, loadPlan: async () => f.plan },
          ),
        ),
        /HR-0310/,
      );
      await assert.rejects(
        as(f, () =>
          nativeVerificationEntryStatus(
            { entryId: f.entry.entryId, employeeId: owned.employee.id },
            { db, loadPlan: async () => f.plan },
          ),
        ),
        /HR-0310/,
      );
      await assert.rejects(
        as(f, () =>
          nativeVerificationEntryStatus(
            { entryId: f.entry.entryId },
            { db, loadPlan: async () => f.plan, now: () => new Date(f.plan.expiresAt) },
          ),
        ),
        /HR-0310/,
      );
    },
  );
  await t.test(
    "lifecycle observation returns actual producer envelope identity without modifying outbox state",
    async () => {
      const before = await transact(f, (tx) =>
        tx.outboxEvent.findMany({
          where: {
            tenantId: f.plan.tenantId,
            eventName: "hr.employee.lifecycle.v1",
            aggregateType: "Employee",
            aggregateId: String(owned.employee.id),
          },
        }),
      );
      assert.equal(before.length, 1);
      const result = await as(f, () =>
        nativeVerificationEntryLifecycle(
          { entryId: f.entry.entryId },
          { db, loadPlan: async () => f.plan },
        ),
      );
      assert.deepEqual(
        Object.keys(result).sort(),
        [
          "grantId",
          "entryId",
          "tenantId",
          "employeeId",
          "employeeUuid",
          "eventId",
          "outboxId",
          "eventName",
          "phase",
          "publishedAt",
          "dispatchAttempts",
        ].sort(),
      );
      assert.equal(result.outboxId, before[0].id);
      assert.equal(result.eventId, before[0].payload.id);
      assert.equal(result.employeeUuid, before[0].payload.payload.employeeId);
      assert.equal(result.publishedAt, null);
      assert.equal(result.dispatchAttempts, 0);
      assert.equal(JSON.stringify(result).includes(f.entry.email), false);
      const after = await transact(f, (tx) =>
        tx.outboxEvent.findMany({ where: { id: before[0].id } }),
      );
      assert.deepEqual(after, before);
    },
  );
  await t.test(
    "lifecycle observation requires exactly one valid owned hired event and valid persisted dispatch fields",
    async () => {
      const row = await transact(f, (tx) =>
        tx.outboxEvent.findFirstOrThrow({
          where: {
            tenantId: f.plan.tenantId,
            eventName: "hr.employee.lifecycle.v1",
            aggregateType: "Employee",
            aggregateId: String(owned.employee.id),
          },
        }),
      );
      const observe = () =>
        as(f, () =>
          nativeVerificationEntryLifecycle(
            { entryId: f.entry.entryId },
            { db, loadPlan: async () => f.plan },
          ),
        );
      for (const mutation of [
        { aggregateId: "unrelated" },
        { payload: { ...row.payload, tenantId: randomUUID() } },
        {
          payload: {
            ...row.payload,
            payload: { ...row.payload.payload, employeeId: randomUUID() },
          },
        },
        { publishedAt: new Date(), attempts: 0 },
      ]) {
        await transact(f, (tx) => tx.outboxEvent.update({ where: { id: row.id }, data: mutation }));
        await assert.rejects(observe(), /HR-0310/);
        await transact(f, (tx) =>
          tx.outboxEvent.update({
            where: { id: row.id },
            data: {
              aggregateId: row.aggregateId,
              payload: row.payload,
              publishedAt: null,
              attempts: 0,
            },
          }),
        );
      }
      // A second actual producer invocation is ambiguous, even if its contents match.
      const duplicate = await transact(f, (tx) =>
        enqueueEmployeeLifecycle(tx, {
          ...mapEmployeeToLifecycleInput(owned.employee, "hired"),
          aggregateId: owned.employee.id,
          actorId: f.plan.bootstrap.userId,
        }),
      );
      await assert.rejects(observe(), /HR-0310/);
      await transact(f, (tx) => tx.outboxEvent.delete({ where: { id: duplicate.id } }));
      // Synthetic persisted-state coverage only; no Redis dispatch is invoked here.
      const publishedAt = new Date();
      await transact(f, (tx) =>
        tx.outboxEvent.update({ where: { id: row.id }, data: { publishedAt, attempts: 2 } }),
      );
      assert.equal((await observe()).publishedAt, publishedAt.toISOString());
      assert.equal((await observe()).dispatchAttempts, 2);
      await transact(f, (tx) =>
        tx.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: null, attempts: 0 } }),
      );
    },
  );
  await t.test(
    "lifecycle observation denies another company, arbitrary selectors and an expired grant",
    async () => {
      await assert.rejects(
        mcpCtx.run({ ...f.ctx, user: { ...f.ctx.user, tenantId: randomUUID() } }, () =>
          nativeVerificationEntryLifecycle(
            { entryId: f.entry.entryId },
            { db, loadPlan: async () => f.plan },
          ),
        ),
        /HR-0310/,
      );
      await assert.rejects(
        as(f, () =>
          nativeVerificationEntryLifecycle(
            { entryId: f.entry.entryId, employeeId: owned.employee.id },
            { db, loadPlan: async () => f.plan },
          ),
        ),
        /HR-0310/,
      );
      await assert.rejects(
        as(f, () =>
          nativeVerificationEntryLifecycle(
            { entryId: f.entry.entryId },
            { db, loadPlan: async () => f.plan, now: () => new Date(f.plan.expiresAt) },
          ),
        ),
        /HR-0310/,
      );
    },
  );
  await t.test("changed request payload cannot replay the same entry", async () => {
    await assert.rejects(
      createOwned({
        ...f,
        authorization: { ...f.authorization, requestFingerprint: "e".repeat(64) },
      }),
      /HR-0310/,
    );
  });
  await t.test("ownership and provisioned business payload are immutable", async () => {
    await assert.rejects(
      transact(f, (tx) =>
        tx.nativeVerificationEntry.update({
          where: { entryId: f.entry.entryId },
          data: { provisioningId: randomUUID() },
        }),
      ),
      /HR-0310|constraint/,
    );
    await assert.rejects(
      transact(f, (tx) =>
        tx.systemAccountProvisioning.update({
          where: { id: owned.systemAccount.id },
          data: { payload: { ...owned.systemAccount.payload, email: "changed@example.invalid" } },
        }),
      ),
      /HR-0310/,
    );
  });
  await t.test("forced RLS hides grants and entries from another tenant", async () => {
    const tenantId = randomUUID();
    await mcpCtx.run({ user: { tenantId } }, () =>
      tenantTransaction(
        db,
        async (tx) => {
          const visible =
            await tx.$queryRaw`SELECT id FROM "NativeVerificationGrant" WHERE id=${f.plan.grantId}::uuid`;
          const entries =
            await tx.$queryRaw`SELECT "entryId" FROM "NativeVerificationEntry" WHERE "entryId"=${f.entry.entryId}::uuid`;
          assert.equal(visible.length, 0);
          assert.equal(entries.length, 0);
        },
        { tenantId },
      ),
    );
    await assert.rejects(
      mcpCtx.run({ user: { tenantId } }, () =>
        tenantTransaction(
          db,
          (tx) =>
            tx.nativeVerificationGrant.create({
              data: {
                id: randomUUID(),
                tenantId,
                runId: "foreign",
                fingerprint: "a".repeat(64),
                plan: f.plan,
                bootstrapUserId: 901,
                operatorReceiptId: "123",
                operatorReceiptFingerprint: "b".repeat(64),
                issuedAt: new Date(),
                expiresAt: new Date(Date.now() + 10000),
              },
            }),
          { tenantId },
        ),
      ),
    );
  });
  await t.test("failed creation rolls employee, intent and ownership back together", async () => {
    const other = fresh();
    await install(other);
    await assert.rejects(createOwned(other, { failAfterBind: true }), /synthetic rollback/);
    assert.equal(
      await transact(other, (tx) =>
        tx.employee.count({ where: { work_email: other.entry.email } }),
      ),
      0,
    );
    assert.equal(
      await transact(other, (tx) =>
        tx.nativeVerificationEntry.count({ where: { grantId: other.plan.grantId } }),
      ),
      0,
    );
  });
  await t.test("worker holds ownership through lost-response and cancellation race", async () => {
    const lease = {
      status: "PROCESSING",
      claimedBy: "native-test-worker",
      claimExpiresAt: new Date(Date.now() + 60000),
    };
    const intent = await transact(f, (tx) =>
      tx.systemAccountProvisioning.update({ where: { id: owned.systemAccount.id }, data: lease }),
    );
    let entered, release;
    const inside = new Promise((resolve) => {
      entered = resolve;
    });
    const rpc = new Promise((resolve) => {
      release = resolve;
    });
    const worker = as(f, () =>
      withNativeHrWorkerClaim(
        db,
        intent,
        async (claim) => {
          assert.equal(claim.provisioningId, owned.systemAccount.id);
          entered();
          await rpc;
          throw new Error("RPC lost response after remote commit");
        },
        { loadPlan: async () => f.plan },
      ),
    );
    const workerOutcome = assert.rejects(worker, /RPC lost response/);
    await inside;
    const cancellation = cancel(f);
    release();
    await workerOutcome;
    const result = await cancellation;
    assert.equal(result.entries.length, 1);
    assert.ok(result.entries[0].deactivationReceiptId);
    const record = await transact(f, (tx) =>
      tx.employee.findUnique({ where: { id: owned.employee.id } }),
    );
    assert.equal(record.status, "Inactive");
    assert.equal(record.employement_status, "Inactive");
    assert.equal(
      await transact(f, (tx) =>
        tx.nativeVerificationEntry.count({ where: { entryId: f.entry.entryId } }),
      ),
      1,
    );
  });
  await t.test("cancelled create/cache replay and worker retries are rejected", async () => {
    await assert.rejects(
      as(f, () =>
        nativeVerificationEntryLifecycle(
          { entryId: f.entry.entryId },
          { db, loadPlan: async () => f.plan },
        ),
      ),
      /HR-0310/,
    );
    await assert.rejects(
      as(f, () =>
        nativeVerificationEntryStatus(
          { entryId: f.entry.entryId },
          { db, loadPlan: async () => f.plan },
        ),
      ),
      /HR-0310/,
    );
    await assert.rejects(createOwned(f), /HR-0310/);
    await assert.rejects(
      as(f, () =>
        withNativeHrWorkerClaim(db, owned.systemAccount, () => assert.fail("must not dispatch"), {
          loadPlan: async () => f.plan,
        }),
      ),
      /HR-0310/,
    );
  });
  await t.test("cleanup retry preserves the original deactivation receipt", async () => {
    const first = await cancel(f),
      second = await cancel(f);
    assert.deepEqual(first.entries, second.entries);
  });
  await t.test(
    "zero-account and partial-account cleanup deactivate every owned HR employee",
    async () => {
      const empty = fresh();
      await install(empty);
      assert.equal((await cancel(empty)).entries.length, 0);
      const partial = fresh();
      await install(partial);
      const row = await createOwned(partial);
      assert.equal(row.systemAccount.rbacUserId, null);
      const result = await cancel(partial);
      assert.equal(result.entries[0].employeeId, row.employee.id);
      assert.ok(result.entries[0].deactivationReceiptId);
    },
  );
});
