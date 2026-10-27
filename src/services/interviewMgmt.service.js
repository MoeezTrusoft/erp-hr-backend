import { getCtx } from "../mcp/context.js";
import { actor } from "./separation/base.js";
import { assertPermission } from "../lib/assertPermission.js";
import { assertAssessmentComplete } from "./candidate-assessment/rules.js";
import { freezeSummary } from "./candidate-assessment/forms.js";
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
// an RBAC Company.uuid string) via scopedWhere/scopedData. F-06 rejects
// tenantless interactive traffic before this service executes.
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { upsertInterviewScorecard } from "./interview-scorecard.service.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  resolveRecruitmentScope,
  interviewScopeWhere,
  hidePeerFeedback,
  maskInterviewForScope,
} from "../lib/recruitmentAccess.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { interviewOutcomeRecordedEvent } from "./hrEvents.js";
import { EvaluationForm } from "@trusoft/contracts/recruitment-assessment";

const RATING_KEYS = [
  "technicalSkills",
  "problemSolving",
  "communication",
  "cultureFit",
];

// Phase 3.4 (remainder) — a two-point spread on the same 1-5 criterion is
// reviewers disagreeing about the same evidence, which is worth putting in front
// of the hiring manager before they decide. It is a SURFACING aid, never a gate:
// nothing here blocks an outcome, and the constant is named so a reader can see
// the threshold rather than infer it from a magic number.
const DIVERGENCE_THRESHOLD = 2;

const finiteRating = (value) => {
  if (
    !["number", "string"].includes(typeof value) ||
    (typeof value === "string" && !value.trim())
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const interviewCriteria = (interview) =>
  interview.formSnapshot
    ? EvaluationForm.parse(interview.formSnapshot).sections.flatMap((section) =>
        section.criteria.map((criterion) => ({
          ...criterion,
          section: section.title,
        })),
      )
    : RATING_KEYS.map((key) => ({
        key,
        label: key,
        scale: "FIVE",
        section: null,
      }));
const cardRating = (card, key) => {
  const structured = card.criterionScores?.find((entry) => entry.key === key);
  return finiteRating(structured ? structured.rating : card.scores?.[key]);
};

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
  const joined = [emp.first_name, emp.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return emp.employee_name || joined || null;
};

const candidateName = (candidate) => {
  if (!candidate) return null;
  return (
    [candidate.firstName, candidate.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || null
  );
};

// Average each of the 4 rating keys across every scorecard's `scores` JSON.
// A key is omitted (null) when no scorecard carries a finite value for it.
const averageRatings = (interview) => {
  const definitions = interviewCriteria(interview);
  const sums = {};
  const counts = {};
  for (const card of submittedCards(interview)) {
    for (const { key } of definitions) {
      const value = cardRating(card, key);
      if (value !== null) {
        sums[key] = (sums[key] || 0) + value;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }
  const out = {};
  for (const { key } of definitions) {
    out[key] = counts[key] ? sums[key] / counts[key] : null;
  }
  return out;
};

const toDatePart = (date) =>
  date ? new Date(date).toISOString().slice(0, 10) : null;
const toTimePart = (date) =>
  date ? new Date(date).toISOString().slice(11, 16) : null;

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
    durationMinutes: interview.durationMinutes ?? 60,
    calendarSyncStatus: interview.calendarSyncStatus ?? null,
    calendarSyncedAt: interview.calendarSyncedAt ?? null,
    calendarProvider: interview.calendarProvider ?? null,
    hasStructuredForm: Boolean(interview.formSnapshot),
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
      ? [
          {
            type: "resume",
            mediaId: candidate.resumeMediaId,
            name: "Candidate Resume",
          },
        ]
      : [],
    ratings: averageRatings(interview),
  };
};

// Phase 3.4 (remainder) — OUTSTANDING FEEDBACK.
//
// The outcome gate only ever asked "is there AT LEAST ONE scorecard?". That made
// a four-person panel decidable by a single reviewer with the other three
// silent, and nothing anywhere told the hiring manager who had not been heard
// from. The panel is the set of interviewers, so a panel member with no SUBMITTED
// scorecard is outstanding by definition. A scorecard that exists but was never
// submitted is not evidence, so it counts as outstanding too.
const submittedCards = (interview) =>
  (interview?.scorecards || []).filter((card) => Boolean(card.submittedAt));

const outstandingFeedback = (interview) => {
  const done = new Set(
    submittedCards(interview).map((card) => Number(card.reviewerId)),
  );
  return (interview?.interviewers || []).reduce((out, link) => {
    const id = link.employee?.id ?? null;
    if (id != null && !done.has(Number(id))) {
      out.push({
        interviewerId: Number(id),
        name: employeeName(link.employee),
        status: link.status ?? null,
      });
    }
    return out;
  }, []);
};

const feedbackSummary = (interview) => {
  const submitted = submittedCards(interview);
  const outstanding = outstandingFeedback(interview);
  return {
    panelSize: (interview?.interviewers || []).length,
    submittedCount: submitted.length,
    outstandingCount: outstanding.length,
    outstanding,
    // "every panel member has been heard" — the state a hiring manager should be
    // in before they close a loop, and the one the outcome path never reported.
    allPanelHeard: outstanding.length === 0,
    lastSubmittedAt: submitted.reduce(
      (latest, card) =>
        card.submittedAt && (!latest || card.submittedAt > latest)
          ? card.submittedAt
          : latest,
      null,
    ),
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
    // A locked record must be visibly locked, and an amendment must be visible
    // rather than a silent difference between two readings of the row.
    locked: Boolean(card.submittedAt),
    amendedAt: card.lastAmendedAt ?? null,
    amendmentCount: Array.isArray(card.amendmentLog)
      ? card.amendmentLog.length
      : 0,
  })),
  feedback: feedbackSummary(interview),
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
  scope = resolveRecruitmentScope(getCtx().user), // Phase 1.4 — record-level narrowing (optional)
} = {}) => {
  const resolvedPage = Number(page) > 0 ? Number(page) : 1;
  const resolvedPageSize =
    Number.isInteger(Number(pageSize)) && Number(pageSize) > 0
      ? Math.min(Number(pageSize), 100)
      : 20;

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

  // The scope predicate composes with the caller's own filters; both must hold.
  const where = scopedWhere(
    tenantId,
    scope ? { AND: [filter, interviewScopeWhere(scope)] } : filter,
  );
  const orderBy = {
    [sort === "scheduledAt" ? "scheduledAt" : sort]:
      order === "desc" ? "desc" : "asc",
  };

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
    items: items.map((i) => shapeRow(maskInterviewForScope(i, scope))),
    total,
    page: resolvedPage,
    pageSize: resolvedPageSize,
  };
};

/**
 * Full interview detail incl. per-reviewer scorecards (tenant-scoped).
 */
export const getInterviewManaged = async ({
  id,
  tenantId,
  scope = resolveRecruitmentScope(getCtx().user),
} = {}) => {
  const interview = await prisma.interview.findFirst({
    where: scopedWhere(tenantId, {
      id: Number(id),
      ...(scope ? interviewScopeWhere(scope) : {}),
    }),
    include: {
      ...interviewInclude,
      lifecycleEvents: {
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          eventType: true,
          notes: true,
          newScheduledAt: true,
          created_at: true,
        },
      },
    },
  });
  if (!interview) {
    throw Object.assign(new Error("Interview not found"), { status: 404 });
  }
  const latest = interview.lifecycleEvents?.[0];
  const maySchedule = ["ORG", "MANAGED"].includes(scope?.level);
  return {
    ...shapeDetail(maskInterviewForScope(interview, scope)),
    rescheduleRequest:
      maySchedule && latest?.eventType === "RESCHEDULE_REQUESTED"
        ? {
            requestedAt: latest.created_at,
            requestedFor: latest.newScheduledAt,
            notes: latest.notes,
          }
        : null,
  };
};

const averageOf = (values = []) => {
  const nums = values.map(finiteRating).filter((value) => value !== null);
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
  amendmentReason = null,
} = {}) => {
  const idNum = Number(interviewId);
  const reviewer = Number(reviewerId);
  if (!Number.isFinite(reviewer)) {
    throw Object.assign(
      new Error(
        "A reviewer (employee) id is required to submit interview feedback",
      ),
      { status: 400 },
    );
  }

  const interview = await prisma.interview.findFirst({
    where: scopedWhere(tenantId, { id: idNum }),
    select: { id: true, formSnapshot: true },
  });
  if (!interview) {
    throw Object.assign(new Error("Interview not found"), { status: 404 });
  }

  if (interview.formSnapshot)
    throw Object.assign(
      new Error("Use the pinned evaluation form to submit structured feedback"),
      { status: 409, code: "HR-6000" },
    );

  const scores = {};
  for (const key of RATING_KEYS) {
    if (ratings[key] != null) scores[key] = Number(ratings[key]);
  }
  const overallScore = averageOf(RATING_KEYS.map((k) => scores[k]));
  const submittedAt = new Date();

  // HR-INTERVIEW-FEEDBACK-01 — a plain prisma upsert still resolves the row
  // through the tenant-scoped where, so a legacy tenant-less scorecard stays
  // invisible to the lookup and then collides on the tenant-blind unique index.
  // The shared writer resolves by the real key and adopts such rows.
  await upsertInterviewScorecard({
    interviewId: idNum,
    reviewerId: reviewer,
    data: {
      scores,
      overallScore,
      recommendation: recommendation ?? null,
      notes: comments ?? null,
      submittedAt,
    },
    tenantId,
    // Phase 3.4 — changing an ALREADY SUBMITTED scorecard requires an explicit
    // amendment reason; without one the shared writer refuses with
    // HR-RECRUITMENT-SCORECARD-LOCKED. An identical resubmit stays a no-op.
    amendment: amendmentReason
      ? { reason: amendmentReason, by: reviewer }
      : null,
  });

  return getInterviewManaged({
    id: idNum,
    tenantId,
    scope: resolveRecruitmentScope(getCtx().user),
  });
};

// Phase 3.4 — interview outcome rules.
//
// A decisive outcome (NEXT_ROUND / REJECTED) feeds the OFFER prerequisite in the
// application workflow ("a completed interview with a NEXT_ROUND decision"). If a
// bare button press could set it, that prerequisite would be satisfiable with no
// evidence behind it and the whole Phase 3 gate would be decorative. So a
// decisive outcome requires at least one SUBMITTED scorecard; the only way past
// that is an explicit `overrideReason`, which is stamped on the interview and
// audited. HOLD stays available — it is an interim state, not a decision.
const INTERVIEW_DECISIONS = Object.freeze(["NEXT_ROUND", "HOLD", "REJECTED"]);
const DECISIVE_DECISIONS = new Set(["NEXT_ROUND", "REJECTED"]);

/**
 * OUTCOME — set Interview.decision and mark the interview COMPLETED.
 * Tenant-scoped pre-read (fail-closed) so a cross-tenant id cannot be mutated.
 */
export const setInterviewOutcome = async ({
  interviewId,
  decision,
  reason,
  overrideReason,
  tenantId,
} = {}) => {
  const ctx = getCtx();
  const fail = (message, status = 409, code = "HR-5401") => {
    throw Object.assign(new Error(message), { status, code });
  };
  if (
    !ctx.actorVerified ||
    !ctx.user?.tenantId ||
    (tenantId && tenantId !== ctx.user.tenantId)
  )
    fail("Verified company context required", 401);
  assertPermission(ctx.permissions, "PUT", "hr:recruitment", false);
  tenantId = ctx.user.tenantId;
  const id = Number(interviewId),
    outcome = String(decision ?? "")
      .trim()
      .toUpperCase();
  if (
    !Number.isInteger(id) ||
    id <= 0 ||
    !INTERVIEW_DECISIONS.includes(outcome)
  )
    fail("Valid interview and outcome required", 422);
  const explanation = String(reason ?? "").trim(),
    override = String(overrideReason ?? "").trim();
  if (outcome === "REJECTED" && explanation.length < 10)
    fail("A rejection requires an explanation of at least 10 characters", 422);
  const scope = await tenantTransaction(
    prisma,
    async (tx) => {
      const who = await actor(tx, ctx),
        scope = resolveRecruitmentScope({ ...ctx.user, employeeId: who.id });
      if (!["ORG", "MANAGED"].includes(scope.level))
        fail("A hiring manager or recruiter must record the outcome", 403);
      await tx.$queryRawUnsafe(
        'SELECT id FROM interviews WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
        tenantId,
        id,
      );
      const current = await tx.interview.findFirst({
        where: { tenantId, id, ...interviewScopeWhere(scope) },
        include: interviewInclude,
      });
      if (!current) fail("Interview not found", 404);
      assertAssessmentComplete(current);
      if (["CANCELLED", "NO_SHOW"].includes(current.status))
        fail("This interview cannot receive an outcome");
      if (current.status === "COMPLETED") {
        if (current.decision === outcome) return scope;
        fail(
          "A completed interview outcome is immutable; schedule another round",
        );
      }
      if (hidePeerFeedback(current, scope).peersHidden)
        fail(
          "Submit your own feedback before recording the panel outcome",
          403,
        );
      const submitted = submittedCards(current),
        outstanding = outstandingFeedback(current);
      const missingEvidence =
        DECISIVE_DECISIONS.has(outcome) && !submitted.length;
      if (missingEvidence && override.length < 10)
        fail(
          "Submitted feedback or an explicit override reason is required",
          409,
          "HR-5402",
        );
      if (missingEvidence && scope.level !== "ORG")
        fail("HR must authorize an outcome without submitted feedback", 403);
      const stamps = [
        "Decision: " + outcome,
        ...(explanation ? ["Reason: " + explanation] : []),
        ...(missingEvidence ? ["Feedback override: " + override] : []),
        ...(outstanding.length
          ? [
              "Outstanding panelists: " +
                outstanding.map((x) => x.interviewerId).join(", "),
            ]
          : []),
      ];
      if (DECISIVE_DECISIONS.has(outcome))
        await freezeSummary(tx, { tenantId, who, now: new Date() }, current);
      await tx.interview.update({
        where: { id },
        data: {
          decision: outcome,
          ...(DECISIVE_DECISIONS.has(outcome) ? { status: "COMPLETED" } : {}),
          notes: [current.notes, ...stamps].filter(Boolean).join("\n"),
        },
      });
      const queued = await enqueueHrDomainEvent(
        tx,
        interviewOutcomeRecordedEvent(
          { id, applicationId: current.applicationId, tenantId, outcome },
          { actorId: who.id },
          {
            overridden: missingEvidence,
            interviewerIds: current.interviewers.map((p) => p.employeeId),
          },
        ),
      );
      if (!queued) fail("Outcome event could not be persisted", 503);
      return scope;
    },
    { tenantId },
  );
  return getInterviewManaged({ id, tenantId, scope });
};

/**
 * Phase 3.4 (remainder) — HIRING-MANAGER CONSOLIDATION.
 *
 * The panel's feedback existed only as N separate scorecards: a hiring manager
 * deciding an offer had to open each one and hold the comparison in their head,
 * and nothing anywhere showed disagreement between reviewers about the SAME
 * criterion. This returns one consolidated, tenant- and record-scoped view:
 *
 *   * per reviewer — overall, recommendation, notes, and whether the record was
 *     amended after submission (and how many times);
 *   * per criterion — average, min, max and spread across everyone who scored it,
 *     with the individual values attributed, so a number is never anonymous;
 *   * who has NOT submitted (the outstanding panel), so an "everyone agreed"
 *     reading is never mistaken for a partial panel;
 *   * `divergentCriteria` — surfaces, it does not decide. Nothing here approves,
 *     rejects, or blocks anything; the human decision remains the human's.
 */
export const consolidateInterviewFeedback = async ({
  id,
  tenantId,
  scope = null,
} = {}) => {
  const interview = await prisma.interview.findFirst({
    // Same scoping as every other read on this surface: a cross-tenant or
    // out-of-scope id resolves to not-found, never to somebody else's panel.
    where: scopedWhere(tenantId, {
      id: Number(id),
      ...(scope ? interviewScopeWhere(scope) : {}),
    }),
    include: interviewInclude,
  });
  if (!interview) {
    throw Object.assign(new Error("Interview not found"), { status: 404 });
  }

  if (hidePeerFeedback(interview, scope).peersHidden)
    throw Object.assign(
      new Error("Submit your own feedback before reading panel ratings"),
      { status: 403, code: "HR-6102" },
    );
  const submitted = submittedCards(interview);

  const criteria = {};
  const definitions = interviewCriteria(interview);
  for (const definition of definitions) {
    const { key, label, scale, section } = definition;
    const values = submitted
      .map((card) => ({
        reviewerId: card.reviewerId,
        reviewer: employeeName(card.reviewer),
        value: cardRating(card, key),
      }))
      .filter((entry) => entry.value !== null);
    const nums = values.map((entry) => entry.value);
    criteria[key] = {
      label,
      scale,
      section,
      divergenceThreshold: scale === "YES_NO" ? 1 : DIVERGENCE_THRESHOLD,
      average: nums.length ? averageOf(nums) : null,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      spread: nums.length ? Math.max(...nums) - Math.min(...nums) : null,
      values,
    };
  }

  const recommendations = submitted.reduce((acc, card) => {
    const key = card.recommendation || "UNSPECIFIED";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const divergentCriteria = definitions
    .map((definition) => definition.key)
    .filter(
      (key) => (criteria[key].spread ?? 0) >= criteria[key].divergenceThreshold,
    );

  return {
    interviewId: interview.id,
    candidateName: candidateName(interview.application?.candidate),
    role: interview.application?.jobRequisition?.title ?? null,
    status: interview.status,
    decision: interview.decision ?? null,
    feedback: feedbackSummary(interview),
    submittedCount: submitted.length,
    averageOverall: averageOf(submitted.map((card) => card.overallScore)),
    overallScale: interview.formSnapshot ? "PERCENT" : "FIVE",
    recommendations,
    criteria,
    divergentCriteria,
    advisory: divergentCriteria.length
      ? `Review the panel's differing ratings on: ${divergentCriteria.map((key) => criteria[key].label).join(", ")}`
      : null,
    reviewers: submitted.map((card) => ({
      reviewerId: card.reviewerId,
      reviewer: employeeName(card.reviewer),
      overallScore: card.overallScore ?? null,
      recommendation: card.recommendation ?? null,
      notes: card.notes ?? null,
      submittedAt: card.submittedAt ?? null,
      amendedAt: card.lastAmendedAt ?? null,
      amendmentCount: Array.isArray(card.amendmentLog)
        ? card.amendmentLog.length
        : 0,
    })),
  };
};
