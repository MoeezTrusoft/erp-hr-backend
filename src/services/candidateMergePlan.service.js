import { createHash } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { getCtx } from "../mcp/context.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
const fail = (message, status = 409, code = "HR-5301") => {
  throw Object.assign(new Error(message), { status, code });
};
const id = (value) => {
  if (!["string", "number"].includes(typeof value)) fail("Choose two candidates", 422);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail("Choose two candidates", 422);
  return n;
};
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = (stage) => ["hired", "rejected", "withdrawn"].includes(stage);
const identity = (row) => ({
  id: row.id,
  version: row.version,
  name: [row.firstName, row.lastName].filter(Boolean).join(" "),
  email: row.email,
  status: row.status,
});
const receiptPrefix = (sourceId, targetId, hash) =>
  `candidate-merge:v2:${sourceId}:${targetId}:${hash}:`;

// Identity-bound evidence is never re-parented. A merge archives the duplicate
// and transfers only applications without downstream identity/history records.
// The preview is mandatory; no historical record is silently rewritten.
export async function mergeCandidates(input = {}) {
  const { tenantId, mode = "PREVIEW" } = input,
    sourceId = id(input.sourceId),
    targetId = id(input.targetId);
  if (sourceId === targetId) fail("A candidate cannot be merged into itself", 422);
  if (!["PREVIEW", "APPLY"].includes(mode)) fail("Choose preview or apply", 422);
  if (input.keepTargetOnConflict != null && typeof input.keepTargetOnConflict !== "boolean")
    fail("Conflict confirmation must be a boolean", 422);
  return tenantTransaction(
    prisma,
    async (tx) => {
      const { who } = await requireRecruitmentActor(
        {
          tenantId,
          permission: "hr.recruitment.update",
          allowedScopes: ["ORG"],
        },
        tx,
      );
      const context = getCtx();
      if (context.user?.isAutomation || context.user?.tokenClaims?.act?.type === "automation")
        fail("An employee must confirm the merge", 403, "HR-5304");
      await tx.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE "tenantId"=$1::uuid AND id=ANY($2::int[]) ORDER BY id FOR UPDATE',
        tenantId,
        [sourceId, targetId],
      );
      const source = await tx.candidate.findFirst({
          where: { tenantId, id: sourceId },
        }),
        target = await tx.candidate.findFirst({
          where: { tenantId, id: targetId },
        });
      if (!source || !target) fail("Candidate not found", 404, "HR-4040");
      if (source.ownerAgencyId || target.ownerAgencyId)
        fail("Agency-owned candidate history cannot be merged");
      if (source.anonymizedAt || target.anonymizedAt)
        fail("Anonymized candidates cannot be merged");
      if (
        mode === "APPLY" &&
        (input.confirmed !== true ||
          typeof input.previewHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(input.previewHash))
      )
        fail("Review the current preview and explicitly confirm the merge", 428, "HR-4280");
      const prefix = mode === "APPLY" ? receiptPrefix(sourceId, targetId, input.previewHash) : null;
      if (prefix) {
        const receipt = await tx.log.findFirst({
          where: {
            tenantId,
            module: "Candidate Merge",
            action_type: "MERGE_CONFIRMED",
            notes: { startsWith: prefix },
          },
          orderBy: { id: "desc" },
        });
        if (receipt)
          return {
            ...JSON.parse(receipt.notes.slice(prefix.length)),
            replayed: true,
          };
      }
      if (source.status !== "active" || target.status !== "active")
        fail("Both candidates must be active before merging");
      const holds = await tx.candidateLegalHold.findMany({
        where: {
          tenantId,
          candidateId: { in: [sourceId, targetId] },
          releasedAt: null,
        },
        select: { candidateId: true },
      });
      if (holds.length) fail("A candidate under legal hold cannot be merged");
      // FK-bearing application writes serialize against these locks. Existing
      // offers/test sessions cannot be re-parented without breaking their evidence.
      await tx.$queryRawUnsafe(
        'SELECT id FROM "Application" WHERE "tenantId"=$1::uuid AND "candidateId"=ANY($2::int[]) ORDER BY id FOR UPDATE',
        tenantId,
        [sourceId, targetId],
      );
      const apps = await tx.$queryRawUnsafe(
        `SELECT a.id,a."candidateId",a."jobRequisitionId",a.stage,a.version,
      (EXISTS(SELECT 1 FROM interviews i WHERE i."tenantId"=a."tenantId" AND i."applicationId"=a.id)
      OR EXISTS(SELECT 1 FROM offers o WHERE o."tenantId"=a."tenantId" AND o."applicationId"=a.id)
      OR EXISTS(SELECT 1 FROM "CandidateTestSession" s WHERE s."tenantId"=a."tenantId" AND s."applicationId"=a.id)
      OR EXISTS(SELECT 1 FROM candidate_communications c WHERE c."tenantId"=a."tenantId" AND c."applicationId"=a.id)
      OR a."talentPoolInvitationId" IS NOT NULL OR a."sourceEmployeeId" IS NOT NULL OR a."internalReferralId" IS NOT NULL OR a."ownerAgencyId" IS NOT NULL OR a."agencySubmissionId" IS NOT NULL) AS protected
      FROM "Application" a WHERE a."tenantId"=$1::uuid AND a."candidateId"=ANY($2::int[]) ORDER BY a.id`,
        tenantId,
        [sourceId, targetId],
      );
      const targetJobs = new Set(
        apps.filter((a) => a.candidateId === targetId).map((a) => a.jobRequisitionId),
      );
      const own = apps.filter((a) => a.candidateId === sourceId),
        conflicts = own.filter((a) => targetJobs.has(a.jobRequisitionId));
      const retained = own.filter((a) => a.protected || targetJobs.has(a.jobRequisitionId)),
        transfer = own.filter((a) => !retained.includes(a));
      const blocked = retained.filter((a) => !terminal(a.stage));
      const hash = digest({
        source: identity(source),
        target: identity(target),
        apps,
      });
      const plan = {
        mode: "PREVIEW",
        source: identity(source),
        target: identity(target),
        previewHash: hash,
        transferredApplicationIds: transfer.map((a) => a.id),
        keptOnSourceApplicationIds: retained.map((a) => a.id),
        conflictingApplicationIds: conflicts.map((a) => a.id),
        blockedApplicationIds: blocked.map((a) => a.id),
        canMerge: blocked.length === 0,
        preservedEvidence: [
          "contact identity",
          "consents",
          "verification tokens",
          "talent pool memberships",
          "skills and AI evidence",
          "documents",
          "interview and offer history",
        ],
      };
      if (mode === "PREVIEW") return plan;
      if (input.previewHash !== hash)
        fail("Candidate or application changed; refresh the merge preview", 412, "HR-4120");
      if (blocked.length)
        fail("Resolve active conflicting or protected applications before merging");
      if (conflicts.length && input.keepTargetOnConflict !== true)
        fail(
          "Explicitly confirm retaining the source application's history for shared requisitions",
        );
      if (transfer.length) {
        const updated = await tx.application.updateMany({
          where: {
            tenantId,
            candidateId: sourceId,
            id: { in: transfer.map((a) => a.id) },
          },
          data: { candidateId: targetId, version: { increment: 1 } },
        });
        if (updated.count !== transfer.length)
          fail("Application changed; refresh the merge preview", 412, "HR-4120");
      }
      // Mailbox authority and consent remain attached to the identity that gave
      // them. Consume every live source token; never make a typo token authorize
      // the survivor's profile. The survivor obtains its own consent/verification.
      await tx.candidateEmailVerification.updateMany({
        where: { tenantId, candidateId: sourceId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.candidate.update({
        where: { id: targetId },
        data: { version: { increment: 1 } },
      });
      await tx.candidate.update({
        where: { id: sourceId },
        data: {
          status: "archived",
          archivedAt: new Date(),
          version: { increment: 1 },
          notes: [
            source.notes,
            `Merged into candidate #${targetId} by employee #${who.id}; identity evidence retained on this archived profile.`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      });
      const result = {
        mode: "APPLY",
        merged: true,
        sourceId,
        targetId,
        actorId: who.id,
        transferredApplicationIds: plan.transferredApplicationIds,
        keptOnSourceApplicationIds: plan.keptOnSourceApplicationIds,
        replayed: false,
      };
      await tx.log.create({
        data: {
          tenantId,
          employeeId: who.id,
          actionById: who.id,
          type: "Update",
          action_type: "MERGE_CONFIRMED",
          module: "Candidate Merge",
          ip: "unknown",
          os: "server",
          result: "SUCCESS",
          notes: prefix + JSON.stringify(result),
        },
      });
      const event = await enqueueHrDomainEvent(tx, {
        tenantId,
        eventName: "hr.recruitment.candidate_merged.v1",
        aggregateType: "Candidate",
        aggregateId: String(targetId),
        actorId: who.id,
        actorType: "user",
        payload: {
          sourceId: String(sourceId),
          targetId: String(targetId),
          actorId: String(who.id),
          transferredApplicationIds: transfer.map((a) => String(a.id)),
          retainedApplicationIds: retained.map((a) => String(a.id)),
        },
      });
      if (!event) fail("Merge audit could not be saved", 503, "HR-5901");
      return result;
    },
    { tenantId, txOptions: { maxWait: 10000, timeout: 30000 } },
  );
}
