import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { getCtx } from "../../mcp/context.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { actor } from "../separation/base.js";
import { submitApproval, actApproval } from "./service.js";
import { fail, loadSource } from "./adapters.js";
export async function legacyWithdraw(
  kind,
  sourceRef,
  reason = "Employee withdrew the request",
) {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.permissions?.includes("hr.approvals.self"))
    fail("Verified employee approval access required", 403);
  if (!["LEAVE", "OVERTIME", "CLAIM", "SHIFT_SWAP"].includes(kind))
    fail("This request cannot be withdrawn");
  const tenantId = ctx.user.tenantId;
  const pending = await tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":approval-source:" + kind + ":" + sourceRef},0))`;
      const row = await tx.hrApprovalRequest.findUnique({
        where: {
          tenantId_kind_sourceRef: {
            tenantId,
            kind,
            sourceRef: String(sourceRef),
          },
        },
      });
      const source = await loadSource(
        tx,
        { tenantId },
        kind,
        String(sourceRef),
        { lock: true, pending: false },
      );
      if (source.who.id !== who.id)
        fail("Only the employee initiator may withdraw", 403);
      if (row?.stage === "WITHDRAWN") return { native: source.row };
      if (row) return { approvalRef: row.id, expectedVersion: row.version };
      if (!source.definition.pending.includes(source.row.status))
        fail("Only a pending request may be withdrawn");
      return {
        native: await tx[source.definition.model].update({
          where: { id: source.row.id },
          data: { status: kind === "LEAVE" ? "CANCELLED" : "WITHDRAWN" },
        }),
      };
    },
    { tenantId },
  );
  if (pending.native) return pending.native;
  await actApproval({
    ...pending,
    action: "WITHDRAW",
    reason: String(reason || "Employee withdrew the request"),
    requestKey: randomUUID(),
  });
  return tenantTransaction(
    prisma,
    async (tx) =>
      (
        await loadSource(tx, { tenantId }, kind, String(sourceRef), {
          pending: false,
        })
      ).row,
    { tenantId },
  );
}
// Legacy decision forms cannot express a versioned stage-specific decision.
// Fail before any balance, payment, attendance or approval-history mutation.
export async function legacyDecision(kind, sourceRef) {
  const ctx = getCtx();
  if (!ctx.actorVerified) fail("Verified employee identity required", 401);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx);
      const source = await loadSource(
        tx,
        { tenantId: ctx.user.tenantId },
        kind,
        String(sourceRef),
        { pending: false },
      );
      const permitted =
        who.id === source.who.id ||
        who.id === source.who.managerId ||
        ["verify", "approve", "read"].some((p) =>
          ctx.permissions?.includes("hr.approvals." + p),
        );
      if (!permitted) fail("Request not found", 404);
      throw Object.assign(
        new Error(
          "HR-4201: Open HR Approval Centre to review the current version and use the action for your stage. Management returns go to HR.",
        ),
        {
          status: 409,
          code: "HR-4201",
          details: {
            workflowUrl: "/hr/approvals",
            kind,
            sourceRef: String(sourceRef),
          },
        },
      );
    },
    { tenantId: ctx.user.tenantId },
  );
}
export async function legacySubmit(
  kind,
  sourceRef,
  reason = "Employee submitted the request",
) {
  const ctx = getCtx();
  if (!ctx.actorVerified) fail("Verified employee identity required", 401);
  const input = await tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx);
      const row = await tx.hrApprovalRequest.findUnique({
        where: {
          tenantId_kind_sourceRef: {
            tenantId: ctx.user.tenantId,
            kind,
            sourceRef: String(sourceRef),
          },
        },
      });
      return {
        kind,
        sourceRef: String(sourceRef),
        employeeCode: who.employee_code,
        expectedVersion: row?.version || 0,
        reason: String(reason || "Employee submitted the request"),
        requestKey: randomUUID(),
      };
    },
    { tenantId: ctx.user.tenantId },
  );
  await submitApproval(input);
  return tenantTransaction(
    prisma,
    async (tx) =>
      (
        await loadSource(
          tx,
          { tenantId: ctx.user.tenantId },
          kind,
          String(sourceRef),
          { pending: false },
        )
      ).row,
    { tenantId: ctx.user.tenantId },
  );
}
