import { createHash, randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { mcpCtx } from "../lib/requestContext.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { evaluateRequisitionEligibility } from "../lib/requisitionEligibility.js";
import { validateSegment } from "../lib/talentPoolPolicy.js";
import {
  segmentTalentPool,
  inviteToApply,
} from "./talentPoolInvitation.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";

const fail = (message, status = 409, code = "HR-5602") => {
  throw Object.assign(new Error(message), { status, code });
};
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const moduleName = "Talent Pool Campaign";
const prefix = (id) => "talent-campaign:" + id + ":";
const blockedCodes = new Set([
  "HR-5701",
  "HR-RECRUITMENT-DNC-BLOCKED",
  "HR-RECRUITMENT-CONSENT-WITHDRAWN",
  "HR-RECRUITMENT-CONSENT-REQUIRED",
]);
export const suggestedCampaignFilters = (job) => {
  const block = job.jobContent?.skills;
  const rows = Array.isArray(block)
    ? block
    : [...(block?.required ?? []), ...(block?.preferred ?? [])];
  const skills = rows
    .map((s) => (typeof s === "string" ? s : s?.name))
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim());
  return {
    ...(skills.length ? { skills } : {}),
    ...(job.location?.trim() ? { locations: [job.location.trim()] } : {}),
    hasOpenInvitation: false,
  };
};
async function openJob(tx, tenantId, jobRequisitionId) {
  const job = await tx.jobRequisition.findFirst({
    where: { tenantId, id: jobRequisitionId, status: "POSTED" },
    include: { postings: { where: { channel: "CAREER_SITE" } } },
  });
  if (
    !job ||
    !evaluateRequisitionEligibility(job, { postings: job.postings }).eligible
  )
    fail("Choose an open job published on the careers site");
  return job;
}
const jobHash = (job) =>
  hash({
    id: job.id,
    title: job.title,
    version: job.version,
    location: job.location,
    jobContent: job.jobContent,
    closesAt: job.closesAt,
  });
async function selection(tx, tenantId, filters) {
  const segment = await segmentTalentPool({
    tenantId,
    filters,
    limit: 101,
    db: tx,
  });
  if (segment.counts.matched > 100)
    return { segment, eligible: [], excluded: 0, tooLarge: true };
  const eligible = [];
  let excluded = 0;
  for (const row of segment.matched) {
    try {
      await assertCommunicationsAllowed(
        { tenantId, candidateId: row.candidateId, purpose: "TALENT_POOL" },
        { db: tx },
      );
      eligible.push(row);
    } catch (error) {
      if (!blockedCodes.has(error.code)) throw error;
      excluded++;
    }
  }
  return { segment, eligible, excluded, tooLarge: false };
}
async function log(tx, tenantId, actorId, action_type, notes) {
  return tx.log.create({
    data: {
      tenantId,
      employeeId: actorId,
      actionById: actorId,
      type: "Update",
      action_type,
      module: moduleName,
      ip: "unknown",
      os: "server",
      result: "SUCCESS",
      notes,
    },
  });
}
/** Preview fixes the exact recipient set. Approval only queues durable messages;
 * the delivery worker independently rechecks job, consent, DNC and retention. */
export async function talentPoolCampaign(input = {}) {
  const { tenantId, mode = "PREVIEW" } = input;
  if (!["PREVIEW", "APPROVE"].includes(mode))
    fail("Choose preview or approve", 422);
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
      const ctx = mcpCtx.getStore();
      if (
        ctx?.system ||
        ctx?.user?.isAutomation ||
        ctx?.user?.tokenClaims?.act?.type === "automation"
      )
        fail("A recruiter must review and approve invitations", 403, "HR-5304");
      if (mode === "PREVIEW") {
        const jobId = Number(input.jobRequisitionId);
        if (
          !Number.isSafeInteger(jobId) ||
          jobId < 1 ||
          !["string", "number"].includes(typeof input.jobRequisitionId)
        )
          fail("Choose a job", 422);
        const job = await openJob(tx, tenantId, jobId);
        const checked = validateSegment(
          input.filters ?? suggestedCampaignFilters(job),
        );
        if (!checked.ok) fail(checked.error, 422);
        const selected = await selection(tx, tenantId, checked.filters);
        const canApprove = !selected.tooLarge && selected.eligible.length > 0;
        const previewId = canApprove ? randomUUID() : null,
          expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
        if (canApprove)
          await log(
            tx,
            tenantId,
            who.id,
            "CAMPAIGN_PREVIEW",
            prefix(previewId) +
              JSON.stringify({
                previewId,
                jobRequisitionId: jobId,
                filters: checked.filters,
                expiresAt,
                candidateIds: selected.eligible.map((c) => c.candidateId),
                selectionHash: hash(selected.eligible),
                jobHash: jobHash(job),
              }),
          );
        return {
          mode,
          previewId,
          expiresAt,
          job: { id: job.id, title: job.title },
          filters: checked.filters,
          candidates: selected.eligible,
          matchedCount: selected.segment.counts.matched,
          excludedCount: selected.excluded,
          canApprove,
          reason: selected.tooLarge
            ? "Narrow the segment to at most 100 matches before reviewing invitations."
            : selected.eligible.length
              ? null
              : "No contactable candidates match this segment.",
        };
      }
      if (
        input.confirmed !== true ||
        typeof input.previewId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(input.previewId)
      )
        fail(
          "Review a current preview and explicitly confirm invitations",
          428,
          "HR-4280",
        );
      const receiptPrefix = prefix(input.previewId);
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        tenantId + ":" + receiptPrefix,
      );
      const receipt = await tx.log.findFirst({
        where: {
          tenantId,
          module: moduleName,
          action_type: "CAMPAIGN_APPROVED",
          notes: { startsWith: receiptPrefix },
        },
        orderBy: { id: "desc" },
      });
      if (receipt)
        return {
          ...JSON.parse(receipt.notes.slice(receiptPrefix.length)),
          replayed: true,
        };
      const preview = await tx.log.findFirst({
        where: {
          tenantId,
          module: moduleName,
          action_type: "CAMPAIGN_PREVIEW",
          notes: { startsWith: receiptPrefix },
        },
        orderBy: { id: "desc" },
      });
      if (!preview) fail("Preview not found", 404);
      const stored = JSON.parse(preview.notes.slice(receiptPrefix.length));
      if (new Date(stored.expiresAt) <= new Date())
        fail("Preview expired; review a fresh segment", 412, "HR-4120");
      await tx.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE "tenantId"=$1::uuid AND id=ANY($2::int[]) ORDER BY id FOR UPDATE',
        tenantId,
        stored.candidateIds,
      );
      await tx.$queryRawUnsafe(
        'SELECT id FROM "JobRequisition" WHERE "tenantId"=$1::uuid AND id=$2 FOR SHARE',
        tenantId,
        stored.jobRequisitionId,
      );
      await tx.$queryRawUnsafe(
        'SELECT id FROM talent_pools WHERE "tenantId"=$1::uuid AND "candidateId"=ANY($2::int[]) ORDER BY id FOR SHARE',
        tenantId,
        stored.candidateIds,
      );
      await tx.$queryRawUnsafe(
        'SELECT id FROM "JobPosting" WHERE "tenantId"=$1::uuid AND "requisitionId"=$2 ORDER BY id FOR SHARE',
        tenantId,
        stored.jobRequisitionId,
      );
      const job = await openJob(tx, tenantId, stored.jobRequisitionId);
      const selected = await selection(tx, tenantId, stored.filters);
      if (
        selected.tooLarge ||
        hash(selected.eligible) !== stored.selectionHash ||
        jobHash(job) !== stored.jobHash
      )
        fail(
          "The job, segment or contact permission changed; review a fresh preview",
          412,
          "HR-4120",
        );
      const invitationIds = [];
      let reused = 0;
      for (const candidateId of stored.candidateIds) {
        const result = await inviteToApply({
          tenantId,
          candidateId,
          jobRequisitionId: job.id,
          validityDays: 30,
          actorId: who.id,
          db: tx,
        });
        invitationIds.push(result.invitation.id);
        if (result.reused) reused++;
      }
      const result = {
        mode,
        previewId: input.previewId,
        jobRequisitionId: job.id,
        actorId: who.id,
        invitationIds,
        queued: invitationIds.length - reused,
        reused,
        replayed: false,
      };
      // The audit receipt and the candidate communication outbox commit together.
      await log(
        tx,
        tenantId,
        who.id,
        "CAMPAIGN_APPROVED",
        receiptPrefix + JSON.stringify(result),
      );
      return result;
    },
    { tenantId, txOptions: { maxWait: 10000, timeout: 60000 } },
  );
}
