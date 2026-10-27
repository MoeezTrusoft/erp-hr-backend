import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { PUBLIC_JOB_SELECT, toPublicJob, getPublicJob } from "../lib/publicPortal.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
  JOB_BOARD_CHANNELS,
  readJobBoardConfig,
  jobBoardConfig,
  renderEmptyBoardFeed,
  jobBoardUnavailable,
  renderJobBoardFeed,
  readBoardReceipt,
  boardReference,
  boardJobUrl,
  issueBoardReceipt,
} from "../lib/job-board-feeds.js";
const notFound = () => Object.assign(new Error("Not found"), { status: 404, code: "HR-5311" });
export async function jobBoardFeed({ tenantId, channel, now = new Date() }, { db = prisma } = {}) {
  return tenantTransaction(
    db,
    async (tx) => {
      if (
        !isRecruitmentFlagEnabled("portal") ||
        !isRecruitmentFlagEnabled("jobBoards") ||
        !JOB_BOARD_CHANNELS.includes(channel)
      )
        throw notFound();
      const setting = await tx.recruitmentSettings.findUnique({
        where: { tenantId },
        select: { policy: true },
      });
      if (
        setting?.policy &&
        Object.hasOwn(setting.policy, "jobBoards") &&
        !setting.policy.jobBoards?.[channel]?.enabled
      )
        return renderEmptyBoardFeed(setting.policy.jobBoards, channel, now);
      const config = jobBoardConfig(tenantId, setting?.policy?.jobBoards);
      if (!config?.[channel]) throw notFound();
      // A repeatable snapshot keeps the public inventory and per-channel rows consistent.
      const rows = await tx.jobRequisition.findMany({
        where: {
          tenantId,
          status: "POSTED",
          postings: { some: { tenantId, channel: "CAREER_SITE", isActive: true, closedAt: null } },
        },
        select: PUBLIC_JOB_SELECT,
        orderBy: { id: "asc" },
        take: 10001,
      });
      if (rows.length > 10000) throw jobBoardUnavailable();
      const jobs = rows.map((row) => toPublicJob(row, { now })).filter((job) => job.eligible);
      const postings = await tx.jobPosting.findMany({
        where: {
          tenantId,
          channel,
          isActive: true,
          closedAt: null,
          requisitionId: { in: jobs.map((job) => job.id) },
        },
        select: { id: true, requisitionId: true, channel: true, channelRef: true, postedAt: true },
      });
      const byJob = new Map();
      for (const posting of postings) {
        if (byJob.has(posting.requisitionId)) throw jobBoardUnavailable();
        byJob.set(posting.requisitionId, posting);
      }
      if (channel === "INDEED" && jobs.some((job) => !byJob.has(job.id)))
        throw jobBoardUnavailable();
      const dates = new Map(
        rows.map((row) => [
          row.id,
          Math.min(
            ...row.postings
              .filter((posting) => posting.isActive && !posting.closedAt)
              .map((posting) => new Date(posting.postedAt).getTime()),
          ),
        ]),
      );
      const published = jobs
        .filter((job) => byJob.has(job.id))
        .map((job) => ({
          job,
          posting: {
            ...byJob.get(job.id),
            postedAt: new Date(
              Math.min(dates.get(job.id), new Date(byJob.get(job.id).postedAt).getTime()),
            ),
          },
        }));
      return renderJobBoardFeed({ tenantId, config, channel, jobs: published, now });
    },
    { tenantId, txOptions: { isolationLevel: "RepeatableRead", timeout: 20000 } },
  );
}
export async function resolveJobBoardSource(
  db,
  { tenantId, requisitionId, receipt, now = new Date() },
) {
  if (!receipt) return "PORTAL";
  const proof = readBoardReceipt(receipt, { tenantId, requisitionId });
  if (!proof) return "PORTAL";
  const config = await readJobBoardConfig(db, tenantId);
  if (!config?.[proof.channel]) return "PORTAL";
  const posting = await db.jobPosting.findFirst({
    where: {
      tenantId,
      id: proof.postingId,
      requisitionId,
      channel: proof.channel,
      channelRef: proof.ref,
      isActive: true,
      closedAt: null,
    },
    select: { id: true },
  });
  if (!posting || !(await getPublicJob({ tenantId, prisma: db, id: requisitionId, now })))
    return "PORTAL";
  return proof.channel;
}

export async function jobBoardApplyRedirect(
  { tenantId, requisitionId, channel, now = new Date() },
  { db = prisma } = {},
) {
  const id = Number(requisitionId);
  const config = jobBoardConfig(tenantId);
  if (!Number.isSafeInteger(id) || id < 1 || !JOB_BOARD_CHANNELS.includes(channel))
    throw notFound();
  return tenantTransaction(
    db,
    async (tx) => {
      const config = await readJobBoardConfig(tx, tenantId);
      if (!config?.[channel]) throw notFound();
      if (!(await getPublicJob({ tenantId, prisma: tx, id, now }))) throw notFound();
      const posting = await tx.jobPosting.findFirst({
        where: {
          tenantId,
          requisitionId: id,
          channel,
          channelRef: boardReference(tenantId, id, channel),
          isActive: true,
          closedAt: null,
        },
        select: { id: true, channel: true, channelRef: true },
      });
      if (!posting) throw notFound();
      return boardJobUrl(
        config,
        id,
        channel,
        issueBoardReceipt({ tenantId, requisitionId: id, posting }),
      );
    },
    { tenantId, txOptions: { isolationLevel: "RepeatableRead", timeout: 10000 } },
  );
}
