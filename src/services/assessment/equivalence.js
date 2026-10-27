import { z } from "zod";
import { AssessmentRef, code } from "@trusoft/contracts/assessment";
import { fail, json, hash, scopeKey, audit, run } from "./base.js";

export const EquivalenceCommand = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("PROPOSE"),
      taskCode: code,
      fromVersion: z.number().int().positive(),
      toVersion: z.number().int().positive(),
      dimensions: z.array(z.enum(["K", "S", "V"])).min(1),
      declaration: z.string().min(30),
    })
    .strict(),
  z
    .object({
      action: z.enum(["APPROVE", "REJECT"]),
      ref: AssessmentRef,
      expectedSequence: z.number().int().nonnegative(),
      declaration: z.string().min(30),
    })
    .strict(),
]);
export async function equivalentCapabilities(tx, tenantId, capabilities) {
  const approvals = await tx.assessmentIntegration.findMany({
    where: { tenantId, kind: "EQUIVALENCE", status: "APPROVED" },
  });
  const result = [...capabilities];
  // A direct, independently approved mapping is required; never infer transitive equivalence.
  for (const a of approvals)
    for (const c of capabilities) {
      const p = a.payload;
      if (
        c.taskCode === p.taskCode &&
        c.taskVersion === p.fromVersion &&
        p.dimensions.includes(c.dimension) &&
        c.scopeKey === p.scopeKey &&
        c.status === "CURRENT" &&
        new Date(c.expiresAt) > new Date()
      )
        result.push({
          ...c,
          taskVersion: p.toVersion,
          sourceTaskVersion: c.taskVersion,
          equivalenceRef: a.id,
        });
    }
  return result;
}
export async function manageEquivalence(raw) {
  const input = EquivalenceCommand.parse(raw);
  return run("hr.assessment_catalog.approve", async (tx, env) => {
    let row;
    if (input.action === "PROPOSE") {
      if (input.toVersion <= input.fromVersion)
        fail(
          "EQUIVALENCE_DIRECTION",
          "Equivalence must reference a newer task version",
        );
      const versions = await tx.assessmentTaskVersion.findMany({
        where: {
          tenantId: env.tenantId,
          taskCode: input.taskCode,
          taskVersion: { in: [input.fromVersion, input.toVersion] },
          status: "PUBLISHED",
        },
      });
      const old = versions.find((t) => t.taskVersion === input.fromVersion),
        next = versions.find((t) => t.taskVersion === input.toVersion);
      if (!old || !next || next.ownerCode !== env.who.employeeCode)
        fail(
          "TASK_OWNER_REQUIRED",
          "The current task owner must propose equivalence between published versions",
          403,
        );
      const a = old.definition,
        b = next.definition;
      if (
        scopeKey(a) !== scopeKey(b) ||
        a.critical !== b.critical ||
        input.dimensions.some(
          (d) => a.applicability[d] !== b.applicability[d],
        ) ||
        hash(a.benchmarkPolicy || {}) !== hash(b.benchmarkPolicy || {})
      )
        fail(
          "SCOPE_NOT_EQUIVALENT",
          "Scope, controls, applicability and timing basis changed; use practical reassessment",
        );
      const key = hash({
        task: input.taskCode,
        from: input.fromVersion,
        to: input.toVersion,
        dimensions: [...input.dimensions].sort(),
      });
      row = await tx.assessmentIntegration.upsert({
        where: {
          tenantId_kind_key: {
            tenantId: env.tenantId,
            kind: "EQUIVALENCE",
            key,
          },
        },
        create: {
          tenantId: env.tenantId,
          employeeCode: env.who.employeeCode,
          kind: "EQUIVALENCE",
          key,
          sourceRef: old.id,
          targetRef: next.id,
          status: "PROPOSED",
          payload: json({
            ...input,
            scopeKey: scopeKey(a),
            proposedByCode: env.who.employeeCode,
            fromDigest: hash(a),
            toDigest: hash(b),
          }),
        },
        update: {},
      });
    } else {
      row = await tx.assessmentIntegration.findFirst({
        where: {
          tenantId: env.tenantId,
          id: input.ref,
          kind: "EQUIVALENCE",
          status: "PROPOSED",
          sequence: input.expectedSequence,
        },
      });
      if (!row) fail("STALE_VERSION", "The equivalence proposal changed", 409);
      if (row.payload.proposedByCode === env.who.employeeCode)
        fail("SEPARATION_REQUIRED", "Independent HR approval is required", 403);
      row = await tx.assessmentIntegration.update({
        where: { id: row.id },
        data: {
          status: input.action === "APPROVE" ? "APPROVED" : "REJECTED",
          sequence: { increment: 1 },
          payload: {
            ...row.payload,
            approvedByCode: env.who.employeeCode,
            decision: input.declaration,
            decidedAt: env.now.toISOString(),
          },
        },
      });
    }
    await audit(tx, env, `EQUIVALENCE_${input.action}`, row.id, input, row);
    return json(row);
  });
}
