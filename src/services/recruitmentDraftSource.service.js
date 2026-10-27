import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { getPublicJob, toPublicJob } from "../lib/publicPortal.js";
import { evaluateRequisitionEligibility } from "../lib/requisitionEligibility.js";
export const employeeMailbox = (employee) =>
  String(employee.work_email?.trim() || employee.email?.trim() || "")
    .trim()
    .toLowerCase();
export const activeSourceEmployee = (employee) =>
  employee &&
  !/inactive|terminated|exited|offboard|separated/i.test(
    employee.status + " " + employee.employement_status,
  );
export async function sourceJob(db, { tenantId, requisitionId, channel, now = new Date() }) {
  if (!["INTERNAL", "REFERRAL", "AGENCY"].includes(channel)) return null;
  if (channel === "AGENCY" && !isRecruitmentFlagEnabled("agency")) return null;
  const requisition = await db.jobRequisition.findFirst({
    where: {
      tenantId,
      id: Number(requisitionId),
      status: "POSTED",
      postings: { some: { isActive: true, closedAt: null, channel } },
    },
    include: {
      postings: { where: { isActive: true, closedAt: null, channel } },
    },
  });
  if (
    !requisition ||
    !evaluateRequisitionEligibility(requisition, {
      postings: requisition.postings,
      now,
    }).eligible
  )
    return null;
  const view = toPublicJob(requisition, { now });
  delete view.eligible;
  delete view.candidateMessage;
  delete view.grade;
  view.department = null;
  view.questions = await db.applicationQuestion.findMany({
    where: { tenantId, requisitionId: requisition.id, isActive: true },
    select: {
      id: true,
      version: true,
      type: true,
      prompt: true,
      required: true,
      options: true,
    },
    orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
  });
  return view;
}
export async function draftSourceJob(db, { tenantId, draft, now = new Date() }) {
  const source = draft.source || "PORTAL";
  if (["PORTAL", "INDEED", "LINKEDIN"].includes(source))
    return getPublicJob({ tenantId, prisma: db, id: draft.requisitionId, now });
  if (source === "INTERNAL") {
    const employee = await db.employee.findFirst({
      where: { tenant_id: tenantId, id: draft.sourceEmployeeId },
    });
    if (
      !activeSourceEmployee(employee) ||
      employeeMailbox(employee) !== String(draft.candidate.email).trim().toLowerCase()
    )
      return null;
  } else if (source === "REFERRAL") {
    const referral = await db.internalReferral.findFirst({
      where: {
        tenantId,
        id: draft.internalReferralId,
        candidateId: draft.candidateId,
        requisitionId: draft.requisitionId,
        state: "INVITED",
        expiresAt: { gt: now },
      },
    });
    if (!referral) return null;
  } else if (source === "AGENCY") {
    const submission = await db.agencySubmission.findFirst({
      where: {
        tenantId,
        id: draft.agencySubmissionId,
        agencyId: draft.ownerAgencyId,
        candidateId: draft.candidateId,
        requisitionId: draft.requisitionId,
        state: "INVITED",
        expiresAt: { gt: now },
      },
    });
    if (
      !submission ||
      !(await db.requisitionAgencyAssignment.findFirst({
        where: {
          tenantId,
          requisitionId: draft.requisitionId,
          agencyId: draft.ownerAgencyId,
          active: true,
        },
      }))
    )
      return null;
  } else return null;
  return sourceJob(db, {
    tenantId,
    requisitionId: draft.requisitionId,
    channel: source,
    now,
  });
}
export function draftApplicationOrigin(draft) {
  if (!draft) return {};
  const source = draft.source || "PORTAL";
  return {
    source,
    sourceEmployeeId: source === "INTERNAL" ? draft.sourceEmployeeId : null,
    internalReferralId: source === "REFERRAL" ? draft.internalReferralId : null,
    ownerAgencyId: source === "AGENCY" ? draft.ownerAgencyId : null,
    agencySubmissionId: source === "AGENCY" ? draft.agencySubmissionId : null,
  };
}
