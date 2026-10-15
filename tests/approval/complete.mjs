// Test-only fixture helper. Decisions use the production service and explicit grants.
import { randomUUID } from "node:crypto";
import { mcpCtx } from "../../src/mcp/context.js";
import { tenantTransaction } from "../../src/lib/rlsTenant.js";
import {
  submitApproval,
  actApproval,
} from "../../src/services/approval/service.js";
import { loadSource } from "../../src/services/approval/adapters.js";
export async function completeBusinessApproval(
  prisma,
  tenantId,
  kind,
  sourceRef,
  reviewers = null,
) {
  process.env.HR_C4_ENCRYPTION_KEY ||= Buffer.alloc(32, 17).toString("base64");
  const db = (fn) =>
    mcpCtx.run({ user: { tenantId } }, () =>
      tenantTransaction(prisma, fn, { tenantId }),
    );
  const team = await db(async (tx) => {
    const { who } = await loadSource(tx, { tenantId }, kind, String(sourceRef));
    if (reviewers) {
      await tx.employee.update({
        where: { id: who.id },
        data: { managerId: reviewers.manager.id },
      });
      return { subject: who, ...reviewers };
    }
    const create = () =>
      tx.employee.create({
        data: {
          tenant_id: tenantId,
          employee_code: "TEST-" + randomUUID().toUpperCase(),
          employeeCategory: "EMPLOYEE",
          positionId: who.positionId,
          userId: 100000 + Math.floor(Math.random() * 1e8),
          status: "Active",
          employement_status: "Active",
        },
      });
    let manager = who.managerId
      ? await tx.employee.findFirst({
          where: { tenant_id: tenantId, id: who.managerId },
        })
      : null;
    if (!manager) {
      manager = await create();
      await tx.employee.update({
        where: { id: who.id },
        data: { managerId: manager.id },
      });
    }
    return {
      subject: who,
      manager,
      hr: await create(),
      management: await create(),
    };
  });
  const as = (who, grant, fn) =>
    mcpCtx.run(
      {
        actorVerified: true,
        user: { tenantId, userId: who.userId },
        permissions: ["hr.approvals.self", "hr.approvals." + grant],
      },
      fn,
    );
  let row = (
    await as(team.subject, "self", () =>
      submitApproval({
        kind,
        sourceRef: String(sourceRef),
        employeeCode: team.subject.employee_code,
        expectedVersion: 0,
        reason: "Fictional employee reviewed this source",
        requestKey: randomUUID(),
      }),
    )
  ).record;
  for (const [person, grant, action] of [
    ["manager", "manager", "RECOMMEND_APPROVAL"],
    ["hr", "verify", "VERIFY"],
    ["management", "approve", "APPROVE"],
  ])
    row = (
      await as(team[person], grant, () =>
        actApproval({
          approvalRef: row.approvalRef,
          expectedVersion: row.version,
          action,
          reason: "Fictional independent evidence review",
          requestKey: randomUUID(),
        }),
      )
    ).record;
  return row;
}
