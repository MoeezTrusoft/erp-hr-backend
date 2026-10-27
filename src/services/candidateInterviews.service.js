import { z } from "zod";
import { withCandidateScheduling } from "./interviewSlots.service.js";
import { requestReschedule } from "./interviewSchedule.service.js";
import { interviewCalendarFile } from "../lib/interviewCalendarFile.js";
const id = z.coerce.number().int().positive();
const missing = () => {
  throw Object.assign(new Error("Interview is unavailable"), {
    status: 404,
    code: "HR-5908",
  });
};
async function rows(db, input, subject) {
  return db.interview.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.interviewId ? { id: id.parse(input.interviewId) } : {}),
      application: {
        tenantId: input.tenantId,
        candidateId: subject.candidateId,
      },
    },
    include: {
      application: {
        select: { stage: true, jobRequisition: { select: { title: true } } },
      },
      lifecycleEvents: {
        where: { tenantId: input.tenantId },
        orderBy: { id: "desc" },
      },
    },
    orderBy: { scheduledAt: "desc" },
    take: 100,
  });
}
export function listOwnInterviews(input) {
  return withCandidateScheduling(input, async (db, subject) => ({
    items: (await rows(db, input, subject)).map((row) => ({
      id: row.id,
      jobTitle: row.application.jobRequisition.title,
      interviewType: row.interviewType,
      scheduledAt: row.scheduledAt,
      durationMinutes: row.durationMinutes,
      location: row.location,
      status: row.status,
      reschedulePending:
        row.lifecycleEvents[0]?.eventType === "RESCHEDULE_REQUESTED",
      canReschedule:
        row.status === "SCHEDULED" &&
        row.scheduledAt > new Date() &&
        !["hired", "rejected", "withdrawn"].includes(row.application.stage),
    })),
  }));
}
export function downloadOwnInterviewCalendar(input) {
  return withCandidateScheduling(input, async (db, subject) => {
    const [row] = await rows(db, input, subject);
    if (!row) missing();
    return interviewCalendarFile({
      ...row,
      jobTitle: row.application.jobRequisition.title,
      sequence: row.lifecycleEvents.filter((e) =>
        ["RESCHEDULED", "CANCELLED"].includes(e.eventType),
      ).length,
    });
  });
}
export function requestOwnInterviewReschedule(input) {
  const interviewId = id.parse(input.interviewId),
    notes = z.string().trim().min(10).max(1000).parse(input.notes),
    requestedFor = z.string().datetime().optional().parse(input.requestedFor);
  if (requestedFor && +new Date(requestedFor) <= Date.now())
    throw Object.assign(new Error("Choose a future preferred time"), {
      status: 422,
      code: "HR-5908",
    });
  return withCandidateScheduling(input, async (db, subject) => {
    const [row] = await rows(db, { ...input, interviewId }, subject);
    if (!row) missing();
    await db.$queryRawUnsafe(
      'SELECT id FROM "Application" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
      row.applicationId,
      input.tenantId,
    );
    const app = await db.application.findFirst({
      where: {
        tenantId: input.tenantId,
        id: row.applicationId,
        candidateId: subject.candidateId,
      },
    });
    if (
      !app ||
      ["hired", "rejected", "withdrawn"].includes(app.stage) ||
      row.scheduledAt <= new Date()
    )
      missing();
    return requestReschedule({
      interviewId,
      tenantId: input.tenantId,
      reasonCode: "CANDIDATE_REQUEST",
      notes,
      requestedFor,
      db,
      candidateId: subject.candidateId,
    });
  });
}
