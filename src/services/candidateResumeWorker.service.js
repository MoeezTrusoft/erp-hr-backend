import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { runWithRequestContext } from "../lib/requestContext.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
  backoffDelayMs,
  isRetryableFailure,
  PARSE_MAX_ATTEMPTS,
} from "../lib/parseRetry.js";
import { parseResumeWithRetry } from "./resumeParsing.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
const LEASE_MS = 5 * 60000;
const lockCandidate = (db, row) =>
  db.$queryRawUnsafe(
    'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
    row.candidateId,
    row.tenantId,
  );
async function activeCandidate(db, row) {
  const c = await db.candidate.findFirst({
    where: {
      id: row.candidateId,
      tenantId: row.tenantId,
      anonymizedAt: null,
      status: "active",
      resumeMediaId: row.mediaId,
    },
  });
  if (!c) return null;
  try {
    await assertCommunicationsAllowed(
      {
        tenantId: row.tenantId,
        candidateId: row.candidateId,
        purpose: "PROCESSING",
        requireExplicitConsent: true,
      },
      { db },
    );
    return c;
  } catch (error) {
    if (error.status >= 400 && error.status < 500) return null;
    throw error;
  }
}
export async function runCandidateResumeParsing({
  now = new Date(),
  limit = 50,
  tenantId,
  parse = parseResumeWithRetry,
} = {}) {
  if (!isRecruitmentFlagEnabled("ai"))
    return { skipped: true, reason: "flag-disabled" };
  const rows = await prisma.candidateResumeParseJob.findMany({
    where: {
      tenantId: tenantId ?? { not: null },
      OR: [
        { status: { in: ["PENDING", "RETRY"] }, dueAt: { lte: now } },
        { status: "RUNNING", leaseUntil: { lte: now } },
      ],
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(100, limit)),
  });
  const totals = { completed: 0, retried: 0, failed: 0, cancelled: 0 };
  for (const row of rows)
    await runWithRequestContext(
      { system: false, user: { tenantId: row.tenantId } },
      async () => {
        const claimed = await tenantTransaction(
          prisma,
          async (db) => {
            await lockCandidate(db, row);
            const locked = await db.$queryRawUnsafe(
              `SELECT id FROM candidate_resume_parse_jobs WHERE id=$1 AND "tenantId"=$2::uuid AND ((status IN ('PENDING','RETRY') AND "dueAt"<=$3) OR (status='RUNNING' AND "leaseUntil"<=$3)) FOR UPDATE SKIP LOCKED`,
              row.id,
              row.tenantId,
              now,
            );
            if (!locked.length) return null;
            const current = await db.candidateResumeParseJob.findUnique({
              where: { id: row.id },
            });
            if (!(await activeCandidate(db, row))) {
              await db.candidateResumeParseJob.update({
                where: { id: row.id },
                data: {
                  status: "CANCELLED",
                  lastError: "CANDIDATE_UNAVAILABLE",
                  leaseToken: null,
                  leaseUntil: null,
                },
              });
              totals.cancelled++;
              return null;
            }
            if (current.attempts >= PARSE_MAX_ATTEMPTS) {
              await db.candidateResumeParseJob.update({
                where: { id: row.id },
                data: {
                  status: "FAILED",
                  lastError: "ATTEMPTS_EXHAUSTED",
                  leaseToken: null,
                  leaseUntil: null,
                },
              });
              await db.candidate.update({
                where: { id: row.candidateId },
                data: {
                  parseStatus: "FAILED",
                  parseError: "Resume parsing needs recruiter review",
                },
              });
              totals.failed++;
              return null;
            }
            const job = await db.candidateResumeParseJob.update({
              where: { id: row.id },
              data: {
                status: "RUNNING",
                attempts: { increment: 1 },
                leaseToken: randomUUID(),
                leaseUntil: new Date(now.getTime() + LEASE_MS),
              },
            });
            await db.candidate.update({
              where: { id: row.candidateId },
              data: { parseStatus: "RUNNING", parseError: null },
            });
            return job;
          },
          { tenantId: row.tenantId },
        );
        if (!claimed) return;
        let result, failure;
        try {
          result = await parse(row.mediaId, {
            kind: "CANDIDATE",
            tenantId: row.tenantId,
            candidateId: row.candidateId,
          });
        } catch (error) {
          failure = error;
        }
        await tenantTransaction(
          prisma,
          async (db) => {
            await lockCandidate(db, row);
            const job = await db.candidateResumeParseJob.findFirst({
              where: {
                id: row.id,
                tenantId: row.tenantId,
                status: "RUNNING",
                leaseToken: claimed.leaseToken,
              },
            });
            if (!job) return;
            const active = await activeCandidate(db, row);
            if (!active) {
              await db.candidateResumeParseJob.update({
                where: { id: row.id },
                data: {
                  status: "CANCELLED",
                  lastError: "CANDIDATE_UNAVAILABLE",
                  leaseToken: null,
                  leaseUntil: null,
                },
              });
              totals.cancelled++;
              return;
            }
            if (failure) {
              const busy = failure.code === "HR-RESUME-BACKOFF";
              const retry =
                (busy || isRetryableFailure(failure)) &&
                !["HR-RESUME-ATTEMPTS-EXHAUSTED"].includes(failure.code) &&
                (busy || job.attempts < PARSE_MAX_ATTEMPTS);
              const delay = busy
                ? Math.max(1000, Number(failure.details?.retryAfterMs) || 60000)
                : backoffDelayMs(job.attempts);
              await db.candidateResumeParseJob.update({
                where: { id: row.id },
                data: {
                  status: retry ? "RETRY" : "FAILED",
                  attempts: busy ? { decrement: 1 } : undefined,
                  dueAt: new Date(now.getTime() + delay),
                  lastError: retry ? "PARSE_RETRY_PENDING" : "PARSE_FAILED",
                  leaseToken: null,
                  leaseUntil: null,
                },
              });
              await db.candidate.update({
                where: { id: row.candidateId },
                data: {
                  parseStatus: retry ? "PENDING" : "FAILED",
                  parseError: retry
                    ? "Resume parsing will retry"
                    : "Resume parsing needs recruiter review",
                },
              });
              totals[retry ? "retried" : "failed"]++;
              return;
            }
            // Replace only AI-generated skills. Human-entered evidence remains authoritative.
            await db.candidateSkill.deleteMany({
              where: {
                tenantId: row.tenantId,
                candidateId: row.candidateId,
                source: "ai-resume",
              },
            });
            const items = [
              ...(result.skills ?? []),
              ...(result.competencies ?? []),
            ];
            for (const item of items) {
              const existing = await db.candidateSkill.findUnique({
                where: {
                  candidateId_name: {
                    candidateId: row.candidateId,
                    name: item.name,
                  },
                },
              });
              if (existing && existing.source !== "ai-resume") continue;
              await db.candidateSkill.upsert({
                where: {
                  candidateId_name: {
                    candidateId: row.candidateId,
                    name: item.name,
                  },
                },
                create: {
                  tenantId: row.tenantId,
                  candidateId: row.candidateId,
                  name: item.name,
                  category: item.category,
                  score: item.score,
                  level: item.level,
                  source: "ai-resume",
                },
                update: {
                  category: item.category,
                  score: item.score,
                  level: item.level,
                  source: "ai-resume",
                },
              });
            }
            await db.candidate.update({
              where: { id: row.candidateId },
              data: {
                parseStatus: "COMPLETED",
                parseError: null,
                parsedAt: new Date(),
                parsedResume: {
                  mediaId: row.mediaId,
                  contentHash: result.contentHash,
                  model: result.model,
                  skills: result.skills ?? [],
                  competencies: result.competencies ?? [],
                  certifications: result.certifications ?? [],
                  yearsOfExperience: result.yearsOfExperience ?? null,
                },
              },
            });
            await db.application.updateMany({
              where: {
                tenantId: row.tenantId,
                candidateId: row.candidateId,
                stage: { notIn: ["hired", "rejected", "withdrawn"] },
              },
              data: { fitScoreCheckedAt: null },
            });
            await db.candidateResumeParseJob.update({
              where: { id: row.id },
              data: {
                status: "COMPLETED",
                lastError: null,
                leaseToken: null,
                leaseUntil: null,
              },
            });
            await enqueueHrDomainEvent(db, {
              tenantId: row.tenantId,
              eventName: "hr.recruitment.candidate_resume_parsed.v1",
              aggregateType: "Candidate",
              aggregateId: row.candidateId,
              payload: {
                candidateId: String(row.candidateId),
                jobId: String(row.id),
                modelVersion: result.model ?? null,
              },
            });
            totals.completed++;
          },
          { tenantId: row.tenantId, txOptions: { timeout: 30000 } },
        );
      },
    );
  return totals;
}
