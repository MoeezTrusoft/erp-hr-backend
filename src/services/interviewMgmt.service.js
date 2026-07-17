// src/services/interviewMgmt.service.js
//
// Interview Management (list/detail) + scoring/feedback service for the HR
// recruitment "Interview Management" screen. Distinct from interview.service.js
// (schedule/update): this surface shapes the FE-facing interview rows (candidate
// + role + interviewers + averaged ratings), exposes per-reviewer scorecards,
// and owns the FEEDBACK write path (upsert a reviewer's InterviewScorecard) and
// the interview OUTCOME write path (Interview.decision + COMPLETED status).
//
// Tenant scoping: every read/write folds the VERIFIED tenant (req.user.tenantId,
// an RBAC Company.uuid string) via scopedWhere/scopedData — fail-closed, a null
// tenant matches only null-tenant rows and can never widen across tenants.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

const RATING_KEYS = ["technicalSkills", "problemSolving", "communication", "cultureFit"];

// Prisma include used by both list + get so the shaped rows always carry the
// candidate, requisition, interviewers (with employee → businessUnit) and the
// full set of scorecards (with reviewer identity for per-reviewer detail).
const interviewInclude = {
  application: {
    include: {
      candidate: true,
      jobRequisition: true,
    },
  },
  interviewers: {
    include: {
      employee: {
        select: {
          id: true,
          employee_name: true,
          first_name: true,
          last_name: true,
          job_title: true,
          work_email: true,
          photo_url: true,
          businessUnit: { select: { name: true } },
        },
      },
    },
  },
  scorecards: {
    include: {
      reviewer: {
        select: {
          id: true,
          employee_name: true,
          first_name: true,
          last_name: true,
        },
      },
    },
  },
};

const employeeName = (emp) => {
  if (!emp) return null;
  const joined = [emp.first_name, emp.last_name].filter(Boolean).join(" ").trim();
  return emp.employee_name || joined || null;
};

const candidateName = (candidate) => {
  if (!candidate) return null;
  return [candidate.firstName, candidate.lastName].filter(Boolean).join(" ").trim() || null;
};

// Average each of the 4 rating keys across every scorecard's `scores` JSON.
// A key is omitted (null) when no scorecard carries a finite value for it.
const averageRatings = (scorecards = []) => {
  const sums = {};
  const counts = {};
  for (const card of scorecards) {
    const scores = card?.scores;
    if (!scores || typeof scores !== "object") continue;
    for (const key of RATING_KEYS) {
      const value = Number(scores[key]);
      if (Number.isFinite(value)) {
        sums[key] = (sums[key] || 0) + value;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }
  const out = {};
  for (const key of RATING_KEYS) {
    out[key] = counts[key] ? sums[key] / counts[key] : null;
  }
  return out;
};

const toDatePart = (date) => (date ? new Date(date).toISOString().slice(0, 10) : null);
const toTimePart = (date) => (date ? new Date(date).toISOString().slice(11, 16) : null);

const shapeInterviewers = (interviewers = []) =>
  interviewers.map((link) => ({
    id: link.employee?.id ?? null,
    name: employeeName(link.employee),
    role: link.employee?.job_title ?? null,
    department: link.employee?.businessUnit?.name ?? null,
    email: link.employee?.work_email ?? null,
    // Profile photo for the avatar (initials fallback handled client-side).
    avatar: link.employee?.photo_url ?? null,
    status: link.status ?? null,
  }));

// FE-facing interview row for the Interview Management list screen.
const shapeRow = (interview) => {
  const candidate = interview.application?.candidate;
  const role = interview.application?.jobRequisition?.title ?? null;
  return {
    interviewId: interview.id,
    candidateName: candidateName(candidate),
    role,
    typeLocation: `${interview.interviewType} / ${interview.location ?? ""}`,
    scheduledAt: interview.scheduledAt,
    interviewers: shapeInterviewers(interview.interviewers),
    status: interview.status,
    decision: interview.decision ?? null,
    interviewType: interview.interviewType,
    schedule: {
      date: toDatePart(interview.scheduledAt),
      time: toTimePart(interview.scheduledAt),
      mode: interview.location ?? null,
      location: interview.location ?? null,
    },
    comments: interview.notes ?? null,
    documents: candidate?.resumeMediaId
      ? [{ type: "resume", mediaId: candidate.resumeMediaId, name: "Candidate Resume" }]
      : [],
    ratings: averageRatings(interview.scorecards),
  };
};

// Full detail — the list row plus per-reviewer scorecards.
const shapeDetail = (interview) => ({
  ...shapeRow(interview),
  durationMinutes: interview.durationMinutes ?? null,
  scorecards: (interview.scorecards || []).map((card) => ({
    reviewer: employeeName(card.reviewer),
    reviewerId: card.reviewerId,
    scores: card.scores ?? {},
    overallScore: card.overallScore ?? null,
    recommendation: card.recommendation ?? null,
    notes: card.notes ?? null,
    submittedAt: card.submittedAt ?? null,
  })),
});

/**
 * List interviews for the Interview Management screen (tenant-scoped),
 * with candidate-name search, status/interviewType/decision filters,
 * scheduledAt sort and pagination. Returns the FE paginated envelope.
 */
export const listInterviewsManaged = async ({
  q,
  status,
  interviewType,
  decision,
  sort = "scheduledAt",
  order = "asc",
  page = 1,
  pageSize = 20,
  tenantId,
} = {}) => {
  const resolvedPage = Number(page) > 0 ? Number(page) : 1;
  const resolvedPageSize = Number(pageSize) > 0 ? Number(pageSize) : 20;

  const filter = {};
  if (status) filter.status = status;
  if (interviewType) filter.interviewType = interviewType;
  if (decision) filter.decision = decision;
  if (q && q.trim()) {
    const term = q.trim();
    filter.application = {
      candidate: {
        OR: [
          { firstName: { contains: term, mode: "insensitive" } },
          { lastName: { contains: term, mode: "insensitive" } },
        ],
      },
    };
  }

  const where = scopedWhere(tenantId, filter);
  const orderBy = { [sort === "scheduledAt" ? "scheduledAt" : sort]: order === "desc" ? "desc" : "asc" };

  const [items, total] = await Promise.all([
    prisma.interview.findMany({
      where,
      orderBy,
      skip: (resolvedPage - 1) * resolvedPageSize,
      take: resolvedPageSize,
      include: interviewInclude,
    }),
    prisma.interview.count({ where }),
  ]);

  return {
    items: items.map(shapeRow),
    total,
    page: resolvedPage,
    pageSize: resolvedPageSize,
  };
};

/**
 * Full interview detail incl. per-reviewer scorecards (tenant-scoped).
 */
export const getInterviewManaged = async ({ id, tenantId } = {}) => {
  const interview = await prisma.interview.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: interviewInclude,
  });
  if (!interview) {
    throw Object.assign(new Error("Interview not found"), { status: 404 });
  }
  return shapeDetail(interview);
};

const averageOf = (values = []) => {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
};

/**
 * FEEDBACK — upsert the caller's scorecard for an interview. Keyed on the
 * @@unique([interviewId, reviewerId]); one scorecard per reviewer per
 * interview. scores = the 4 ratings JSON, overallScore = avg of the ratings.
 * Tenant-scoped pre-read (fail-closed) so a cross-tenant id cannot be scored.
 */
export const scoreInterview = async ({
  interviewId,
  reviewerId,
  ratings = {},
  recommendation,
  comments,
  tenantId,
} = {}) => {
  const idNum = Number(interviewId);
  const reviewer = Number(reviewerId);
  if (!Number.isFinite(reviewer)) {
    throw Object.assign(
      new Error("A reviewer (employee) id is required to submit interview feedback"),
      { status: 400 }
    );
  }

  const interview = await prisma.interview.findFirst({
    where: scopedWhere(tenantId, { id: idNum }),
    select: { id: true },
  });
  if (!interview) {
    throw Object.assign(new Error("Interview not found"), { status: 404 });
  }

  const scores = {};
  for (const key of RATING_KEYS) {
    if (ratings[key] != null) scores[key] = Number(ratings[key]);
  }
  const overallScore = averageOf(RATING_KEYS.map((k) => scores[k]));
  const submittedAt = new Date();

  await prisma.interviewScorecard.upsert({
    where: { interviewId_reviewerId: { interviewId: idNum, reviewerId: reviewer } },
    create: scopedData(tenantId, {
      interviewId: idNum,
      reviewerId: reviewer,
      scores,
      overallScore,
      recommendation: recommendation ?? null,
      notes: comments ?? null,
      submittedAt,
    }),
    update: {
      scores,
      overallScore,
      recommendation: recommendation ?? null,
      notes: comments ?? null,
      submittedAt,
    },
  });

  return getInterviewManaged({ id: idNum, tenantId });
};

/**
 * OUTCOME — set Interview.decision and mark the interview COMPLETED.
 * Tenant-scoped pre-read (fail-closed) so a cross-tenant id cannot be mutated.
 */
export const setInterviewOutcome = async ({ interviewId, decision, tenantId } = {}) => {
  const idNum = Number(interviewId);
  const interview = await prisma.interview.findFirst({
    where: scopedWhere(tenantId, { id: idNum }),
    select: { id: true },
  });
  if (!interview) {
    throw Object.assign(new Error("Interview not found"), { status: 404 });
  }

  await prisma.interview.update({
    where: { id: idNum },
    data: { decision, ...(decision ? { status: "COMPLETED" } : {}) },
  });

  return getInterviewManaged({ id: idNum, tenantId });
};
