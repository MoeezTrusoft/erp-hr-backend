import { z } from "zod";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { getCtx } from "../mcp/context.js";
import { actor } from "./separation/base.js";
import { assertPermission } from "../lib/assertPermission.js";
import {
  resolveRecruitmentScope,
  applicationScopeWhere,
} from "../lib/recruitmentAccess.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
  readInterviewCalendarAvailability,
  assertInterviewCalendarAvailable,
  lockInterviewPanel,
} from "./recruitmentCalendar.service.js";
import { createScheduledInterview } from "./interview.service.js";
import { resolveStatusLink } from "./candidateVerification.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { enqueueCandidateCommunication } from "./candidateCommunicationQueue.service.js";
const id = z.coerce.number().int().positive();
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status, code: "HR-5908" });
};
const enabled = () => {
  if (!isRecruitmentFlagEnabled("calendar"))
    fail("Interview self-scheduling is not enabled", 404);
};
export const SlotOfferInput = z
  .object({
    applicationId: id,
    interviewType: z.enum([
      "PHONE_SCREEN",
      "TECHNICAL",
      "BEHAVIORAL",
      "PANEL",
      "FINAL",
      "ONSITE",
      "VIDEO",
    ]),
    durationMinutes: z.number().int().min(5).max(480),
    location: z.string().trim().max(1000).default(""),
    siteRef: z.string().trim().max(100).optional(),
    interviewerIds: z.array(id).min(1).max(20),
    panelRoles: z
      .record(
        z.string(),
        z.enum(["TECHNICAL", "HIRING_MANAGER", "HR", "CULTURE"]),
      )
      .default({}),
    slots: z.array(z.string().datetime()).min(3).max(5),
    expiresAt: z.string().datetime(),
  })
  .strict();
async function staff(db, method) {
  const ctx = getCtx();
  if (!ctx.actorVerified || !ctx.user.tenantId)
    fail("Verified company context required", 401);
  assertPermission(ctx.permissions, method, "hr:recruitment", false);
  const who = await actor(db, ctx),
    scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
  if (!["ORG", "MANAGED"].includes(scope.level))
    fail("Recruiter or hiring manager required", 403);
  return { tenantId: ctx.user.tenantId, who, scope };
}
async function application(db, tenantId, applicationId, where = {}) {
  await db.$queryRawUnsafe(
    `SELECT id FROM "Application" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE`,
    applicationId,
    tenantId,
  );
  const row = await db.application.findFirst({
    where: { tenantId, id: applicationId, ...where },
    include: { candidate: true, jobRequisition: true },
  });
  if (!row) fail("Interview scheduling is unavailable", 404);
  return row;
}
async function canSchedule(db, app) {
  if (
    ["hired", "rejected", "withdrawn"].includes(app.stage) ||
    ["CLOSED", "WITHDRAWN", "CANCELLED", "ARCHIVED"].includes(
      app.jobRequisition.status,
    )
  )
    fail("This application is no longer available for interview scheduling");
  if (app.candidate.status !== "active" || app.candidate.anonymizedAt)
    fail("Interview scheduling is unavailable", 404);
  await assertCommunicationsAllowed(
    {
      tenantId: app.tenantId,
      candidateId: app.candidateId,
      purpose: "PROCESSING",
      requireExplicitConsent: true,
    },
    { db },
  );
  if (!["interview", "offer"].includes(app.stage)) {
    const screening = await db.applicationScreening.findFirst({
      where: {
        tenantId: app.tenantId,
        applicationId: app.id,
        recordKind: "DECISION",
      },
      orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
    });
    if (
      !["screening", "on_hold"].includes(app.stage) ||
      screening?.outcome !== "ADVANCE"
    )
      fail("Record a screening ADVANCE before offering interview slots");
  }
}
const present = (row, now = new Date()) => ({
  id: row.id,
  applicationId: row.applicationId,
  interviewType: row.interviewType,
  durationMinutes: row.durationMinutes,
  location: row.location,
  slots: row.slots,
  expiresAt: row.expiresAt,
  status:
    row.status === "OPEN" && row.expiresAt <= now ? "EXPIRED" : row.status,
  interviewId: row.interviewId,
  chosenAt: row.chosenAt,
  createdAt: row.createdAt,
});
export async function createSlotOffer(input) {
  enabled();
  const args = SlotOfferInput.parse(input),
    now = new Date(),
    times = args.slots.map((s) => +new Date(s)).sort((a, b) => a - b),
    expiry = new Date(args.expiresAt);
  if (
    new Set(args.interviewerIds).size !== args.interviewerIds.length ||
    Object.keys(args.panelRoles).some(
      (k) => !args.interviewerIds.includes(Number(k)),
    )
  )
    fail("Assign distinct panelists and roles only for that panel", 422);
  if (
    times.some(
      (t, i) =>
        t <= +now ||
        t > +now + 14 * 86400000 ||
        (i > 0 && t < times[i - 1] + args.durationMinutes * 60000),
    ) ||
    expiry <= now ||
    +expiry > times[0]
  )
    fail(
      "Choose three to five non-overlapping future slots within fourteen days, with expiry before the first slot",
      422,
    );
  return tenantTransaction(prisma, async (db) => {
    const { tenantId, who, scope } = await staff(db, "POST"),
      app = await application(
        db,
        tenantId,
        args.applicationId,
        applicationScopeWhere(scope),
      );
    await canSchedule(db, app);
    const employees = await db.employee.findMany({
      where: { tenant_id: tenantId, id: { in: args.interviewerIds } },
      select: { id: true, status: true, employement_status: true },
    });
    if (
      employees.length !== args.interviewerIds.length ||
      employees.some((e) =>
        /inactive|terminated|exited|offboard|separated/i.test(
          [e.status, e.employement_status].join(" "),
        ),
      )
    )
      fail("Every panelist must be an active employee in this company", 422);
    await lockInterviewPanel(db, tenantId, args.interviewerIds);
    for (const time of times)
      assertInterviewCalendarAvailable(
        await readInterviewCalendarAvailability(db, {
          tenantId,
          scheduledAt: new Date(time),
          durationMinutes: args.durationMinutes,
          interviewerIds: args.interviewerIds,
        }),
      );
    await db.$executeRawUnsafe(
      `UPDATE "InterviewSlotOffer" SET status='WITHDRAWN',"updatedAt"=$3 WHERE "tenantId"=$1::uuid AND "applicationId"=$2 AND status='OPEN'`,
      tenantId,
      app.id,
      now,
    );
    const [row] = await db.$queryRawUnsafe(
      `INSERT INTO "InterviewSlotOffer" ("tenantId","applicationId","createdById","interviewType","durationMinutes",location,"siteRef",panel,slots,"expiresAt") VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING *`,
      tenantId,
      app.id,
      who.id,
      args.interviewType,
      args.durationMinutes,
      args.location,
      args.siteRef ?? null,
      JSON.stringify(
        args.interviewerIds.map((employeeId) => ({
          employeeId,
          panelRole: args.panelRoles[employeeId] ?? null,
        })),
      ),
      JSON.stringify(times.map((t) => new Date(t).toISOString())),
      expiry,
    );
    await enqueueCandidateCommunication(db, {
      tenantId,
      candidateId: app.candidateId,
      applicationId: app.id,
      templateKey: "interview_slots_offered",
      dedupeKey: "interview-slot-offer:" + row.id,
      context: { slotOfferId: row.id },
      expiresAt: expiry,
    });
    return present(row);
  });
}
export async function listSlotOffers(input) {
  enabled();
  const appId = id.parse(input.applicationId);
  return tenantTransaction(prisma, async (db) => {
    const { tenantId, scope } = await staff(db, "GET");
    await application(db, tenantId, appId, applicationScopeWhere(scope));
    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM "InterviewSlotOffer" WHERE "tenantId"=$1::uuid AND "applicationId"=$2 ORDER BY id DESC LIMIT 20`,
      tenantId,
      appId,
    );
    return { items: rows.map((r) => present(r)) };
  });
}
export async function withdrawSlotOffer(input) {
  enabled();
  const offerId = id.parse(input.id);
  return tenantTransaction(prisma, async (db) => {
    const { tenantId, scope } = await staff(db, "PUT"),
      [offer] = await db.$queryRawUnsafe(
        `SELECT * FROM "InterviewSlotOffer" WHERE "tenantId"=$1::uuid AND id=$2`,
        tenantId,
        offerId,
      );
    if (!offer) fail("Slot offer not found", 404);
    await application(
      db,
      tenantId,
      offer.applicationId,
      applicationScopeWhere(scope),
    );
    const rows = await db.$queryRawUnsafe(
      `UPDATE "InterviewSlotOffer" SET status='WITHDRAWN',"updatedAt"=CURRENT_TIMESTAMP WHERE "tenantId"=$1::uuid AND id=$2 AND status='OPEN' RETURNING *`,
      tenantId,
      offerId,
    );
    if (!rows.length && offer.status !== "WITHDRAWN")
      fail("This slot offer is no longer open");
    return present(rows[0] ?? offer);
  });
}
// Possession of a live status-link is the candidate credential. Revalidate after
// locking so revocation, withdrawal and erasure cannot race a booking.
export async function withCandidateScheduling(input, action) {
  enabled();
  return tenantTransaction(
    prisma,
    async (db) => {
      await db.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      const subject = await resolveStatusLink({ ...input, db });
      if (!subject)
        fail(
          "Interview scheduling is unavailable. Request a new status link.",
          404,
        );
      await db.$queryRawUnsafe(
        `SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE`,
        subject.candidateId,
        input.tenantId,
      );
      const live = await resolveStatusLink({ ...input, db });
      if (!live || live.candidateId !== subject.candidateId)
        fail(
          "Interview scheduling is unavailable. Request a new status link.",
          404,
        );
      await assertCommunicationsAllowed(
        {
          tenantId: input.tenantId,
          candidateId: subject.candidateId,
          purpose: "PROCESSING",
          requireExplicitConsent: true,
        },
        { db },
      );
      return action(db, subject);
    },
    { tenantId: input.tenantId, txOptions: { timeout: 30000, maxWait: 10000 } },
  );
}
export function listOwnSlotOffers(input) {
  return withCandidateScheduling(input, async (db, subject) => {
    const rows = await db.$queryRawUnsafe(
      `SELECT s.*,r.title AS "jobTitle" FROM "InterviewSlotOffer" s JOIN "Application" a ON a.id=s."applicationId" AND a."tenantId"=s."tenantId" JOIN "JobRequisition" r ON r.id=a."jobRequisitionId" AND r."tenantId"=a."tenantId" WHERE s."tenantId"=$1::uuid AND a."candidateId"=$2 AND a.stage NOT IN ('hired','rejected','withdrawn') AND s.status='OPEN' AND s."expiresAt">CURRENT_TIMESTAMP ORDER BY s.id DESC LIMIT 100`,
      input.tenantId,
      subject.candidateId,
    );
    return {
      items: rows.map((r) => ({ ...present(r), jobTitle: r.jobTitle })),
    };
  });
}
export function bookOwnSlot(input) {
  const offerId = id.parse(input.id),
    chosen = z.string().datetime().parse(input.scheduledAt);
  return withCandidateScheduling(input, async (db, subject) => {
    const [offer] = await db.$queryRawUnsafe(
      `SELECT s.* FROM "InterviewSlotOffer" s JOIN "Application" a ON a.id=s."applicationId" AND a."tenantId"=s."tenantId" WHERE s."tenantId"=$1::uuid AND s.id=$2 AND a."candidateId"=$3`,
      input.tenantId,
      offerId,
      subject.candidateId,
    );
    if (!offer) fail("Interview scheduling is unavailable", 404);
    const app = await application(db, input.tenantId, offer.applicationId, {
      candidateId: subject.candidateId,
    });
    const [current] = await db.$queryRawUnsafe(
      `SELECT * FROM "InterviewSlotOffer" WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE`,
      input.tenantId,
      offerId,
    );
    if (current.status === "BOOKED" && +current.chosenAt === +new Date(chosen))
      return { interviewId: current.interviewId, replayed: true };
    const now = new Date();
    if (
      current.status !== "OPEN" ||
      current.expiresAt <= now ||
      +new Date(chosen) <= +now ||
      !current.slots.some((s) => +new Date(s) === +new Date(chosen))
    )
      fail(
        "This slot is no longer available. Please ask the recruitment team for new times.",
      );
    await canSchedule(db, app);
    const interview = await createScheduledInterview(db, {
      applicationId: app.id,
      tenantId: input.tenantId,
      interviewType: current.interviewType,
      scheduledAt: chosen,
      durationMinutes: current.durationMinutes,
      location: current.location,
      siteRef: current.siteRef,
      interviewerIds: current.panel.map((p) => p.employeeId),
      panelRoles: Object.fromEntries(
        current.panel
          .filter((p) => p.panelRole)
          .map((p) => [p.employeeId, p.panelRole]),
      ),
    });
    await db.$executeRawUnsafe(
      `UPDATE "InterviewSlotOffer" SET status='BOOKED',"chosenAt"=$3,"interviewId"=$4,"updatedAt"=$5 WHERE "tenantId"=$1::uuid AND id=$2`,
      input.tenantId,
      offerId,
      new Date(chosen),
      interview.id,
      now,
    );
    return { interviewId: interview.id, replayed: false };
  });
}
