import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { mcpCtx } from "../../mcp/context.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { startOutboxDispatchLoop } from "../../jobs/outbox.loop.js";
import { SourceSnapshot } from "@trusoft/contracts/employment";
import { applyCategoryConversion } from "../employee-code.service.js";
import {
  change,
  event,
  notify,
  json,
  fail,
  currentCode,
  touch,
} from "./base.js";
import { companyDate } from "./rules.js";
import {
  storeSourceSnapshot,
  deliverEmploymentRequest,
} from "./integrations.js";

export async function sweepCompany(tx, env) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":separation-sweep"},0))`;
  for (const row of await tx.employeeCategoryConversion.findMany({
    where: {
      tenantId: env.tenantId,
      state: "APPROVED",
      effectiveAt: { lte: env.now },
    },
  }))
    await applyCategoryConversion(tx, env, row);
  const rows = await tx.separation.findMany({
    where: {
      tenantId: env.tenantId,
      state: { notIn: ["EXIT_COMPLETED", "WITHDRAWN", "CANCELLED"] },
    },
  });
  for (let s of rows) {
    await tx.$queryRaw`SELECT id FROM "Separation" WHERE "tenantId"=${env.tenantId}::uuid AND id=${s.id}::uuid FOR UPDATE`;
    s = await tx.separation.findUnique({ where: { id: s.id } });
    if (["EXIT_COMPLETED", "WITHDRAWN", "CANCELLED"].includes(s.state))
      continue;
    if (
      s.deferredUntil &&
      s.deferredUntil.toISOString().slice(0, 10) <=
        companyDate(env.now, s.policySnapshot.timeZone)
    )
      s = await change(
        tx,
        env,
        s,
        "MANAGER_REVIEW",
        "DEFERRAL_DUE",
        "Deferred review date reached",
        {
          deferredUntil: null,
          recommendation: null,
          verification: null,
          verifiedByCode: null,
        },
      );
    if (s.approvedAt && s.lastWorkingAt <= env.now && !s.accessDueEmittedAt) {
      s = await touch(tx, env, s, "ACCESS_DUE", "Last working time reached", {
        accessDueEmittedAt: env.now,
      });
      await event(tx, env, s, "hr.separation.access_due.v1");
      await tx.assessmentCapability.updateMany({
        where: {
          tenantId: env.tenantId,
          employeeCode: s.employeeCode,
          status: "CURRENT",
        },
        data: { status: "EXPIRED" },
      });
    }
    if (!s.approvedAt) continue;
    const date = companyDate(env.now, s.policySnapshot.timeZone),
      remaining = Math.ceil((s.lastWorkingAt - env.now) / 86400000);
    for (const model of [
      "replacementSession",
      "knowledgeTransferItem",
      "assetHandoverItem",
      "accessRevocationTask",
      "clearanceItem",
    ]) {
      const open = await tx[model].findMany({
        where: {
          tenantId: env.tenantId,
          separationRef: s.id,
          status: { not: "COMPLETED" },
        },
      });
      for (const t of open)
        if (t.dueAt <= env.now || remaining <= s.policySnapshot.reminderDays) {
          const key = `reminder:${t.id}:${date}`;
          await notify(
            tx,
            env,
            s,
            t.dueAt <= env.now ? "TASK_OVERDUE" : "EXIT_DUE_SOON",
            key,
          );
          const d = await tx.employmentDelivery.findUnique({
            where: { tenantId_key: { tenantId: env.tenantId, key } },
          });
          if (t.ownerCode)
            await tx.employmentDelivery.update({
              where: { id: d.id },
              data: {
                payload: {
                  ...d.payload,
                  recipientCodes: [
                    ...new Set([...d.payload.recipientCodes, t.ownerCode]),
                  ],
                  taskRef: t.id,
                },
              },
            });
        }
    }
  }
}
export async function processDelivery(
  tenantId,
  id,
  { deliver = deliverEmploymentRequest, now = new Date() } = {},
) {
  const txRun = (fn) =>
    tenantTransaction(prisma, fn, { tenantId, txOptions: { timeout: 30000 } });
  let delivery = await txRun(async (tx) => {
    const d = await tx.employmentDelivery.findFirst({
      where: {
        tenantId,
        id,
        state: { in: ["PENDING", "RETRY", "PROCESSING"] },
        nextAttemptAt: { lte: now },
      },
    });
    if (!d) return null;
    const separation = await tx.separation.findFirst({
      where: { tenantId, id: d.payload.separationRef },
    });
    if (
      !separation ||
      (["CANCELLED", "WITHDRAWN"].includes(separation.state) &&
        d.kind !== "NOTIFICATION")
    ) {
      await tx.employmentDelivery.update({
        where: { id: d.id },
        data: { state: "CANCELLED", version: { increment: 1 } },
      });
      return null;
    }
    if (d.kind === "PAYROLL_HANDOFF") {
      const sheet = await tx.finalSettlementSheet.findFirst({
        where: { tenantId, id: d.payload.settlementRef },
      });
      if (sheet?.status === "COMPLETED" && sheet.payload.payrollReceiptRef) {
        await tx.employmentDelivery.updateMany({
          where: { id, tenantId, version: d.version },
          data: {
            state: "DELIVERED",
            lastError: null,
            version: { increment: 1 },
          },
        });
        return null;
      }
    }
    const claimed = await tx.employmentDelivery.updateMany({
      where: { id, tenantId, version: d.version },
      data: {
        state: "PROCESSING",
        nextAttemptAt: new Date(+now + 60000),
        version: { increment: 1 },
      },
    });
    return claimed.count ? d : null;
  });
  if (!delivery) return;
  try {
    if (delivery.kind === "PAYROLL_HANDOFF")
      delivery = await txRun(async (tx) => {
        const sheet = await tx.finalSettlementSheet.findFirst({
          where: { tenantId, id: delivery.payload.settlementRef },
        });
        if (!sheet || sheet.status !== "HANDED_OFF")
          fail("Settlement is no longer ready for handoff", 409);
        return {
          ...delivery,
          payload: { ...delivery.payload, sheet: sheet.payload },
        };
      });
    if (delivery.kind === "NOTIFICATION")
      delivery = await txRun(async (tx) => {
        const recipients = [];
        for (const oldCode of delivery.payload.recipientCodes) {
          const employeeCode = await currentCode(tx, tenantId, oldCode);
          const e = await tx.employee.findFirst({
            where: { tenant_id: tenantId, employee_code: employeeCode },
            select: { work_email: true },
          });
          if (!e?.work_email)
            fail("A notification recipient has no verified work email", 409);
          recipients.push({ email: e.work_email });
        }
        return { ...delivery, payload: { ...delivery.payload, recipients } };
      });
    const response = await deliver(delivery);
    await txRun(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Separation" WHERE "tenantId"=${tenantId}::uuid AND id=${delivery.payload.separationRef}::uuid FOR UPDATE`;
      const lease = await tx.employmentDelivery.findFirst({
        where: {
          id,
          tenantId,
          state: "PROCESSING",
          version: delivery.version + 1,
        },
      });
      if (!lease) return; // A newer worker owns this delivery; never overwrite its result.
      const s = await tx.separation.findFirst({
          where: { tenantId, id: delivery.payload.separationRef },
        }),
        env = { tenantId, now, who: null };
      if (
        !s ||
        (["CANCELLED", "WITHDRAWN"].includes(s.state) &&
          delivery.kind !== "NOTIFICATION")
      ) {
        await tx.employmentDelivery.update({
          where: { id },
          data: { state: "CANCELLED" },
        });
        return;
      }
      if (delivery.kind.startsWith("FETCH_")) {
        const { companyUuid, ...sourceResponse } = response;
        const input = SourceSnapshot.parse({
          ...sourceResponse,
          employeeCode: s.employeeCode,
          separationRef: s.id,
          expectedVersion: s.version,
          requestKey: randomUUID(),
        });
        const { requestKey, expectedVersion, ...snapshot } = input;
        await storeSourceSnapshot(tx, env, s, snapshot);
      } else if (delivery.kind === "PAYROLL_HANDOFF") {
        if (!response.receiptRef) fail("Payroll did not confirm receipt", 502);
        const sheet = await tx.finalSettlementSheet.findFirst({
          where: { tenantId, id: delivery.payload.settlementRef },
        });
        if (
          sheet.version !== delivery.payload.settlementVersion ||
          sheet.status !== "HANDED_OFF"
        )
          fail("Settlement changed during handoff", 409);
        await tx.finalSettlementSheet.update({
          where: { id: sheet.id },
          data: {
            status: "COMPLETED",
            payload: {
              ...sheet.payload,
              payrollReceiptRef: response.receiptRef,
            },
            version: { increment: 1 },
          },
        });
        await touch(
          tx,
          env,
          s,
          "PAYROLL_ACKNOWLEDGED",
          "Verified payroll receipt accepted",
        );
      }
      await tx.employmentDelivery.update({
        where: { id },
        data: {
          state: "DELIVERED",
          attempts: { increment: 1 },
          lastError: null,
          version: { increment: 1 },
        },
      });
    });
  } catch (error) {
    await txRun((tx) =>
      tx.employmentDelivery.updateMany({
        where: {
          id,
          tenantId,
          state: "PROCESSING",
          version: delivery.version + 1,
        },
        data: {
          state: "RETRY",
          attempts: { increment: 1 },
          nextAttemptAt: new Date(
            +now +
              Math.min(3600000, 30000 * 2 ** Math.min(delivery.attempts, 7)),
          ),
          lastError: String(error.code || "INTEGRATION_UNAVAILABLE").slice(
            0,
            100,
          ),
          version: { increment: 1 },
        },
      }),
    );
  }
}
export async function runSeparationAutomation() {
  const companies = await mcpCtx.run(
    { system: true },
    async () =>
      await prisma.separationPolicy.findMany({ select: { tenantId: true } }),
  );
  const conversions = await mcpCtx.run(
    { system: true },
    async () =>
      await prisma.employeeCategoryConversion.findMany({
        where: { state: "APPROVED" },
        select: { tenantId: true },
        distinct: ["tenantId"],
      }),
  );
  for (const tenantId of new Set(
    [...companies, ...conversions].map((c) => c.tenantId),
  ))
    await mcpCtx.run({ user: { tenantId } }, async () => {
      await tenantTransaction(
        prisma,
        (tx) => sweepCompany(tx, { tenantId, now: new Date(), who: null }),
        { tenantId, txOptions: { timeout: 60000 } },
      );
      const due = await prisma.employmentDelivery.findMany({
        where: {
          tenantId,
          state: { in: ["PENDING", "RETRY", "PROCESSING"] },
          nextAttemptAt: { lte: new Date() },
        },
        take: 30,
        orderBy: { nextAttemptAt: "asc" },
      });
      for (const d of due) await processDelivery(tenantId, d.id);
    });
}
export function startSeparationWorker() {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.HR_SEPARATION_WORKER_ENABLED !== "true"
  )
    return { stop: async () => {} };
  return startOutboxDispatchLoop({
    run: runSeparationAutomation,
    intervalMs: 15000,
    errorBackoffMs: 30000,
  });
}
