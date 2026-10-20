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
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { upsertInterviewScorecard } from "./interview-scorecard.service.js";
import { logAction } from "../utils/logs.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { interviewScopeWhere } from "../lib/recruitmentAccess.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { interviewOutcomeRecordedEvent } from "./hrEvents.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";

// Phase 3a — loaded lazily: the decision-prompt service consolidates feedback
// through this module, so a static import would be a cycle.
const loadDecisionPrompts = () => import("./interview-decision-prompt.service.js");

const RATING_KEYS = ["technicalSkills", "problemSolving", "communication", "cultureFit"];

// Phase 3.4 (remainder) — a two-point spread on the same 1-5 criterion is
// reviewers disagreeing about the same evidence, which is worth putting in front
// of the hiring manager before they decide. It is a SURFACING aid, never a gate:
// nothing here blocks an outcome, and the constant is named so a reader can see
// the threshold rather than infer it from a magic number.
const DIVERGENCE_THRESHOLD = 2;

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
  const done = new Set(submittedCards(interview).map((card) => Number(card.reviewerId)));
  return (interview?.interviewers || []).reduce((out, link) => {
    const id = link.employee?.id ?? null;
    if (id != null && !done.has(Number(id))) {
      out.push({ interviewerId: Number(id), name: employeeName(link.employee), status: link.status ?? null });
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
      (latest, card) => (card.submittedAt && (!latest || card.submittedAt > latest) ? card.submittedAt : latest),
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
    amendmentCount: Array.isArray(card.amendmentLog) ? card.amendmentLog.length : 0,
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
  scope = null, // Phase 1.4 — record-level narrowing (optional)
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

  // The scope predicate composes with the caller's own filters; both must hold.
  const where = scopedWhere(tenantId, scope ? { AND: [filter, interviewScopeWhere(scope)] } : filter);
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
export const getInterviewManaged = async ({ id, tenantId, scope = null } = {}) => {
  const interview = await prisma.interview.findFirst({
    where: scopedWhere(tenantId, { id: Number(id), ...(scope ? interviewScopeWhere(scope) : {}) }),
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
  amendmentReason = null,
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
    amendment: amendmentReason ? { reason: amendmentReason, by: reviewer } : null,
  });

  return getInterviewManaged({ id: idNum, tenantId });
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
  actorId,
  tenantId,
} = {}) => {
  const idNum = Number(interviewId);
  if (!Number.isInteger(idNum) || idNum <= 0) {
    throw Object.assign(new Error("A valid interview id is required"), { status: 400 });
  }

  const normalizedDecision = String(decision || "").trim().toUpperCase();
  if (!INTERVIEW_DECISIONS.includes(normalizedDecision)) {
    throw Object.assign(
      new Error(`Unsupported interview decision: ${normalizedDecision || "(missing)"}`),
      { status: 409, code: "HR-RECRUITMENT-INTERVIEW-DECISION-INVALID" },
    );
  }

  const reasonText = String(reason || "").trim();
  if (normalizedDecision === "REJECTED" && !reasonText) {
    throw Object.assign(
      new Error("A reason is required when rejecting a candidate at interview"),
      { status: 409, code: "HR-RECRUITMENT-INTERVIEW-REASON-REQUIRED" },
    );
  }

  const interview = await prisma.interview.findFirst({
    where: scopedWhere(tenantId, { id: idNum }),
    // applicationId + tenantId travel to the outcome event (ids-only payload).
    // The panel and their scorecards travel too: the outcome path must be able to
    // say WHO has not been heard from, and it cannot do that from the row alone.
    select: {
      id: true,
      notes: true,
      applicationId: true,
      tenantId: true,
      // Phase 3a — the auto-advance acts on a CHANGE to NEXT_ROUND only.
      decision: true,
      interviewers: {
        select: {
          status: true,
          employee: { select: { id: true, employee_name: true, first_name: true, last_name: true } },
        },
      },
      scorecards: { select: { reviewerId: true, submittedAt: true } },
    },
  });
  if (!interview) {
    throw Object.assign(new Error("Interview not found"), { status: 404 });
  }

  const overrideText = String(overrideReason || "").trim();
  let overriddenWithoutFeedback = false;
  if (DECISIVE_DECISIONS.has(normalizedDecision)) {
    // Phase 3.4 (remainder) — only a SUBMITTED scorecard is evidence. A row that
    // exists but was never submitted used to satisfy this gate.
    const submitted = await prisma.interviewScorecard.count({
      where: scopedWhere(tenantId, { interviewId: idNum, submittedAt: { not: null } }),
    });
    if (!submitted) {
      if (!overrideText) {
        throw Object.assign(
          new Error("At least one submitted scorecard is required before a decisive interview outcome (pass overrideReason to override)"),
          { status: 409, code: "HR-RECRUITMENT-INTERVIEW-FEEDBACK-REQUIRED" },
        );
      }
      overriddenWithoutFeedback = true;
    }
  }

  // The decision (plus why it was made) is appended to the interview notes so the
  // record explains itself without relying on the audit log alone.
  const stamps = [`Decision: ${normalizedDecision}`];
  if (reasonText) stamps.push(`Reason: ${reasonText}`);
  if (overriddenWithoutFeedback) stamps.push(`Overridden without scorecard: ${overrideText}`);

  // Phase 3.4 (remainder) — the outcome records who has NOT been heard from. It
  // does not BLOCK on them: a panel member who will never submit must not be able
  // to stall hiring, and the gate above already guarantees real evidence. What it
  // must never do is stay silent about a decidable-but-incomplete panel, which is
  // how a one-reviewer decision passes as unanimous.
  const outstanding = outstandingFeedback(interview);
  if (outstanding.length) {
    stamps.push(
      `Outstanding panel feedback (${outstanding.length}): ${outstanding
        .map((member) => member.name || `#${member.interviewerId}`)
        .join(", ")}`,
    );
  }

  const notes = interview.notes ? `${interview.notes}\n${stamps.join("\n")}` : stamps.join("\n");

  // Phase 11 — the decision and its announcement commit together. The event is
  // ids-only and flags whether the outcome rode an override, so the fabric shows
  // that a human overrode the evidence gate rather than leaving it invisible.
  await tenantTransaction(prisma, async (tx) => {
    await tx.interview.update({
      where: { id: idNum },
      data: { decision: normalizedDecision, status: "COMPLETED", notes },
    });

    await logAction({
      employeeId: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
      type: "UPDATE",
      module: "InterviewOutcome",
      result: "SUCCESS",
      notes: `Interview "${idNum}" outcome set to "${normalizedDecision}"${overriddenWithoutFeedback ? " (overridden without scorecard)" : ""}${outstanding.length ? ` (${outstanding.length} panel member(s) had not submitted feedback)` : ""}.`,
      tenantId: typeof tenantId !== "undefined" ? tenantId : null,
    });

    await enqueueHrDomainEvent(
      tx,
      interviewOutcomeRecordedEvent(
        // The ROW's tenant is authoritative (as in the application workflow): a
        // legacy tenantless interview simply produces no event, rather than an
        // event attributed to whatever tenant the caller passed in.
        { id: idNum, applicationId: interview.applicationId ?? null, tenantId: interview.tenantId ?? null, outcome: normalizedDecision },
        { actorId: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null },
        {
          overridden: overriddenWithoutFeedback,
          reason: reasonText || overrideText || null,
          // Phase 11 — the panel is the routing list a notification consumer
          // fans "your panel decided X" over. Read from the same pre-read the
          // outstanding-feedback report uses, so the two can never disagree.
          interviewerIds: (interview.interviewers || [])
            .map((link) => link.employee?.id)
            .filter((value) => value != null),
        },
      ),
    );

    // Phase 3a — a NEXT_ROUND decision advances the application (or asks for
    // the next round) in the same transaction, so the decision and its
    // consequence commit together. REJECTED never auto-rejects.
    if (isRecruitmentFlagEnabled("decisionPrompts")) {
      const { applyDecisionAutoAdvance } = await loadDecisionPrompts();
      await applyDecisionAutoAdvance(tx, {
        tenantId: interview.tenantId ?? null,
        interviewId: idNum,
        decision: normalizedDecision,
        previousDecision: interview.decision ?? null,
        actorId: Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? Number(actorId) : null,
      });
    }
  });

  return getInterviewManaged({ id: idNum, tenantId });
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
export const consolidateInterviewFeedback = async ({ id, tenantId, scope = null } = {}) => {
  const interview = await prisma.interview.findFirst({
    // Same scoping as every other read on this surface: a cross-tenant or
    // out-of-scope id resolves to not-found, never to somebody else's panel.
    where: scopedWhere(tenantId, { id: Number(id), ...(scope ? interviewScopeWhere(scope) : {}) }),
    include: interviewInclude,
  });
  if (!interview) {
    throw Object.assign(new Error("Interview not found"), { status: 404 });
  }

  const submitted = submittedCards(interview);

  const criteria = {};
  for (const key of RATING_KEYS) {
    const values = submitted
      .map((card) => ({
        reviewerId: card.reviewerId,
        reviewer: employeeName(card.reviewer),
        value: Number(card.scores?.[key]),
      }))
      .filter((entry) => Number.isFinite(entry.value));
    const nums = values.map((entry) => entry.value);
    criteria[key] = {
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

  const divergentCriteria = RATING_KEYS.filter(
    (key) => (criteria[key].spread ?? 0) >= DIVERGENCE_THRESHOLD,
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
    recommendations,
    criteria,
    divergentCriteria,
    advisory: divergentCriteria.length
      ? `Reviewers disagree by ${DIVERGENCE_THRESHOLD} points or more on: ${divergentCriteria.join(", ")}`
      : null,
    reviewers: submitted.map((card) => ({
      reviewerId: card.reviewerId,
      reviewer: employeeName(card.reviewer),
      overallScore: card.overallScore ?? null,
      recommendation: card.recommendation ?? null,
      notes: card.notes ?? null,
      submittedAt: card.submittedAt ?? null,
      amendedAt: card.lastAmendedAt ?? null,
      amendmentCount: Array.isArray(card.amendmentLog) ? card.amendmentLog.length : 0,
    })),
  };
};
