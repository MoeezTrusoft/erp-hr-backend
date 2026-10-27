import { z } from "zod";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { resolveStatusLink } from "./candidateVerification.service.js";
import { transitionApplicationStage } from "./applicationWorkflow.service.js";
import { cancelInterview } from "./interviewSchedule.service.js";
import { recordDataAccessRequest } from "./candidatePrivacy.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { portalPolicy } from "../lib/portalPolicy.js";
const bad = () =>
  Object.assign(
    new Error("This link is not valid. Request a new status link."),
    { status: 404, code: "HR-5801" },
  );
async function authenticated(tenantId, token, action) {
  const subject = await resolveStatusLink({ tenantId, token });
  if (!subject) throw bad();
  return tenantTransaction(
    prisma,
    async (db) => {
      await db.$executeRaw`SELECT id FROM "Candidate" WHERE id = ${subject.candidateId} AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      const candidate = await db.candidate.findFirst({
        where: {
          tenantId,
          id: subject.candidateId,
          anonymizedAt: null,
          status: "active",
        },
      });
      if (!candidate) throw bad();
      return action(db, candidate);
    },
    { tenantId },
  );
}
export const withdrawOwnApplication = ({ tenantId, token, applicationId }) =>
  authenticated(tenantId, token, async (db, candidate) => {
    const application = await db.application.findFirst({
      where: {
        tenantId,
        id: z.coerce.number().int().positive().parse(applicationId),
        candidateId: candidate.id,
      },
      include: { offer: { select: { status: true } } },
    });
    if (!application) throw bad();
    if (
      application.offer?.status === "ACCEPTED" ||
      application.stage === "hired"
    )
      throw Object.assign(
        new Error("Please contact recruitment about your accepted offer."),
        { status: 409, code: "HR-5301" },
      );
    await transitionApplicationStage({
      db,
      tenantId,
      id: application.id,
      targetStage: "withdrawn",
      reason: "Candidate withdrew through verified self-service",
      source: "candidate-portal",
    });
    // The cancellation event tells calendar/notification delivery workers to remove pending appointments.
    const interviews = await db.interview.findMany({
      where: { tenantId, applicationId: application.id, status: "SCHEDULED" },
      select: { id: true },
    });
    for (const interview of interviews) {
      await cancelInterview({
        db,
        tenantId,
        interviewId: interview.id,
        reasonCode: "CANDIDATE_REQUEST",
        notes: "Candidate withdrew through verified self-service",
      });
    }
    return { withdrawn: true };
  });
export const candidatePreferences = ({ tenantId, token }) =>
  authenticated(tenantId, token, async (db, candidate) => {
    const rows = await db.candidateConsent.findMany({
      where: {
        tenantId,
        candidateId: candidate.id,
        purpose: { in: ["TALENT_POOL", "MARKETING"] },
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    });
    return Object.fromEntries(
      ["TALENT_POOL", "MARKETING"].map((purpose) => [
        purpose,
        rows.find((r) => r.purpose === purpose)?.status === "GRANTED",
      ]),
    );
  });
export const saveCandidatePreferences = ({
  tenantId,
  token,
  preferences,
  policyVersion,
}) =>
  authenticated(tenantId, token, async (db, candidate) => {
    const input = z
      .object({ TALENT_POOL: z.boolean(), MARKETING: z.boolean() })
      .strict()
      .parse(preferences);
    if (policyVersion !== portalPolicy(tenantId).version)
      throw Object.assign(
        new Error("Please review the current privacy policy."),
        { status: 400, code: "HR-5803" },
      );
    for (const [purpose, granted] of Object.entries(input)) {
      const latest = await db.candidateConsent.findFirst({
        where: { tenantId, candidateId: candidate.id, purpose },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      });
      const status = granted ? "GRANTED" : "WITHDRAWN";
      if (latest?.status !== status)
        await db.candidateConsent.create({
          data: {
            tenantId,
            candidateId: candidate.id,
            purpose,
            status,
            policyVersion,
            source: "candidate-portal",
          },
        });
    }
    await enqueueHrDomainEvent(db, {
      tenantId,
      eventName: "hr.recruitment.candidate_preferences_changed.v1",
      aggregateType: "Candidate",
      aggregateId: candidate.id,
      payload: { candidateId: String(candidate.id) },
    });
    return input;
  });
export const requestOwnData = ({ tenantId, token, type, notes }) =>
  authenticated(tenantId, token, async (db, candidate) => {
    const input = z
      .object({
        type: z.enum(["ACCESS", "CORRECTION", "ERASURE"]),
        notes: z.string().trim().max(5000).optional(),
      })
      .parse({ type, notes });
    const existing = await db.candidateDataAccessRequest.findFirst({
      where: {
        tenantId,
        candidateId: candidate.id,
        type: input.type,
        status: { in: ["RECEIVED", "IN_PROGRESS"] },
      },
    });
    const request =
      existing ??
      (await recordDataAccessRequest(
        {
          tenantId,
          subjectEmail: candidate.email,
          candidateId: candidate.id,
          ...input,
        },
        { db },
      ));
    if (!existing)
      await enqueueHrDomainEvent(db, {
        tenantId,
        eventName: "hr.recruitment.privacy_requested.v1",
        aggregateType: "CandidateDataAccessRequest",
        aggregateId: request.id,
        payload: {
          requestId: String(request.id),
          candidateId: String(candidate.id),
          type: input.type,
        },
      });
    return {
      received: true,
      reference: request.id,
      dueAt: request.dueAt?.toISOString() ?? null,
    };
  });
