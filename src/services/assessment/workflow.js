import { consumeApproval } from '../approval/adapters.js';
import {
  AssignmentCommand,
  ObservationCommand,
  WorkflowCommand,
} from "@trusoft/contracts/assessment";
import {
  chooseRaters,
  validateDecision,
  velocity,
  reviewTier,
  coverage,
} from "@trusoft/contracts/assessment-rules";
import {
  run,
  config,
  identity,
  fail,
  audit,
  event,
  hash,
  json,
  days,
  cas,
  assignmentAccess,
  scopeKey,
  exception,
  currentProfile,
  verifyAssessmentScope,
} from "./base.js";
import { brief, restrict } from "./evidence.js";
import { publishDownstream } from "./downstream.js";
import { loadAttendanceRuntime } from "../../lib/attendanceRuntime.js";
import { dateRange } from "../../lib/attendanceDates.js";

export async function qualifiedCandidates(
  tx,
  env,
  employee,
  families,
  capacity,
) {
  const people = await tx.assessmentIdentity.findMany({
    where: { tenantId: env.tenantId, active: true },
  });
  const qualifications = await tx.assessmentQualification.findMany({
    where: { tenantId: env.tenantId, familyCode: { in: families } },
  });
  const disputes = await tx.assessmentAssignment.findMany({
    where: {
      tenantId: env.tenantId,
      employeeCode: employee.employeeCode,
      state: "DISPUTED",
    },
    select: { raterCode: true, reviewerCode: true },
  });
  const conflicted = new Set(
    disputes.flatMap((a) => [a.raterCode, a.reviewerCode]),
  );
  const active = await tx.assessmentAssignment.findMany({
    where: {
      tenantId: env.tenantId,
      state: {
        in: [
          "ASSIGNED",
          "IN_PROGRESS",
          "RETURNED",
          "UNDER_REVIEW",
          "ACKNOWLEDGMENT_DUE",
        ],
      },
    },
    select: { raterCode: true, reviewerCode: true, taskCodes: true },
  });
  const leave = await tx.leaveRequest.findMany({
    where: {
      tenantId: env.tenantId,
      status: "APPROVED",
      startDate: { lte: env.now },
      endDate: { gte: env.now },
    },
    select: { employeeId: true },
  });
  const legacyLeave = await tx.leave.findMany({
    where: {
      tenantId: env.tenantId,
      status: "APPROVED",
      start_date: { lte: env.now },
      end_date: { gte: env.now },
    },
    select: { employeeId: true },
  });
  let calendar;
  const from = env.now.toISOString().slice(0, 10),
    to = capacity
      ? new Date(Math.min(Date.parse(capacity.dueAt), +env.now + days(21)))
          .toISOString()
          .slice(0, 10)
      : null;
  if (capacity)
    calendar = await loadAttendanceRuntime({
      tenantId: env.tenantId,
      from,
      to,
      db: tx,
    });
  return people.map((p) => {
    let capacityMinutes;
    if (calendar) {
      const shifts = dateRange(from, to, 24).map((d) =>
        calendar.resolve(p.employeeRowId, d),
      );
      const available = shifts
        .filter((s) => s.working === true && s.shift)
        .reduce(
          (sum, s) =>
            sum +
            Math.max(
              0,
              (+new Date(s.shift.end) - +new Date(s.shift.start)) / 60000 -
                (s.shift.exclusions || []).reduce(
                  (n, i) => n + (+new Date(i.end) - +new Date(i.start)) / 60000,
                  0,
                ),
            ),
          0,
        );
      const allocated = active
        .filter((a) => [a.raterCode, a.reviewerCode].includes(p.employeeCode))
        .reduce(
          (sum, a) =>
            sum +
            a.taskCodes.length *
              (a.raterCode === p.employeeCode
                ? capacity.policy.raterTaskMinutes
                : capacity.policy.reviewerTaskMinutes),
          0,
        );
      capacityMinutes =
        Math.floor(available * capacity.policy.raterCapacityShare) - allocated;
    }
    return {
      ...p,
      active: p.active && !conflicted.has(p.employeeCode),
      capacityMinutes,
      onLeave:
        (capacity && capacityMinutes < capacity.minutes) ||
        [...leave, ...legacyLeave].some(
          (l) => l.employeeId === p.employeeRowId,
        ),
      openCount: active.filter(
        (a) =>
          a.raterCode === p.employeeCode || a.reviewerCode === p.employeeCode,
      ).length,
      qualifications: qualifications.filter(
        (q) => q.employeeCode === p.employeeCode,
      ),
    };
  });
}
export async function createAssignment(tx, env, input, automated = false) {
  const digest = hash(input),
    prior = await tx.assessmentAssignment.findFirst({
      where: { tenantId: env.tenantId, idempotencyKey: input.idempotencyKey },
    });
  if (prior) {
    if (prior.inputDigest !== digest)
      fail(
        "IDEMPOTENCY_CONFLICT",
        "Assignment key reused with different content",
        409,
      );
    return prior;
  }
  const cfg = await config(tx, env.tenantId);
  if (["FOUNDATION", "EVIDENCE_SHADOW"].includes(cfg.policy.stage))
    fail(
      "ROLLOUT_GATE",
      "Assessment assignment is not enabled for this company",
    );
  if (
    await tx.assessmentException.findFirst({
      where: {
        tenantId: env.tenantId,
        kind: "CIRCUIT_BREAKER",
        status: "OPEN",
      },
    })
  )
    fail(
      "AUTOMATION_PAUSED",
      "Resolve company data integrity exceptions before assigning",
    );
  const employee = await identity(tx, env.tenantId, input.employeeCode);
  const profile = await tx.assessmentProfileVersion.findFirst({
    where: {
      tenantId: env.tenantId,
      id: input.profileRef,
      status: "PUBLISHED",
    },
  });
  if (!profile) fail("PROFILE_MISSING", "Select a published profile");
  if ((await currentProfile(tx, env, employee)).id !== profile.id)
    fail(
      "PROFILE_SCOPE_CHANGED",
      "Assign only the employee’s current approved role profile",
    );
  const membership = await tx.employeeAssessmentProfile.findFirst({
    where: {
      tenantId: env.tenantId,
      employeeCode: input.employeeCode,
      profileRef: input.profileRef,
      effectiveFrom: { lte: env.now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: env.now } }],
    },
  });
  if (!membership)
    fail(
      "PROFILE_ASSIGNMENT_MISSING",
      "Approve the employee role profile before assigning an assessment",
    );
  const tasks = (
    await tx.assessmentTaskVersion.findMany({
      where: {
        tenantId: env.tenantId,
        status: "PUBLISHED",
        OR: profile.definition.requirements.map((r) => ({
          taskCode: r.taskCode,
          taskVersion: r.taskVersion,
        })),
      },
    })
  ).map((t) => t.definition);
  const selected = input.taskCodes || tasks.map((t) => t.taskCode);
  if (
    !selected.length ||
    selected.some((c) => !tasks.some((t) => t.taskCode === c))
  )
    fail("TASK_OUT_OF_SCOPE", "Select tasks from the approved profile");
  const families = [
    ...new Set(
      tasks
        .filter((t) => selected.includes(t.taskCode))
        .map((t) => t.familyCode),
    ),
  ];
  const candidates = await qualifiedCandidates(
    tx,
    env,
    employee,
    families,
    automated
      ? {
          dueAt: input.dueAt,
          policy: cfg.policy,
          minutes: selected.length * cfg.policy.raterTaskMinutes,
        }
      : null,
  );
  const selection = chooseRaters({
    employee,
    candidates,
    familyCodes: families,
    now: env.now,
    maxOpen: cfg.policy.raterMaxOpen,
  });
  const raterCode = input.raterCode || selection.raterCode,
    reviewerCode = input.reviewerCode || selection.reviewerCode;
  if (!raterCode || !reviewerCode)
    fail(
      "NO_QUALIFIED_REVIEWER",
      "A qualified independent rater and reviewer are required",
    );
  const rater = candidates.find((c) => c.employeeCode === raterCode),
    reviewer = candidates.find((c) => c.employeeCode === reviewerCode);
  for (const person of [rater, reviewer]) {
    if (
      !person ||
      !person.active ||
      person.onLeave ||
      person.openCount >= cfg.policy.raterMaxOpen ||
      person.employeeCode === employee.employeeCode ||
      person.managerCode === employee.employeeCode ||
      families.some(
        (f) =>
          !person.qualifications.some(
            (q) =>
              q.familyCode === f &&
              q.expiresAt > env.now &&
              q.calibration.passed &&
              !q.flags.includes("DISQUALIFIED") &&
              tasks
                .filter(
                  (t) => t.familyCode === f && selected.includes(t.taskCode),
                )
                .every(
                  (t) => q.scopes.includes(t.scope) || q.scopes.includes("*"),
                ),
          ),
      )
    )
      fail(
        "RATER_UNQUALIFIED",
        "Selected rater/reviewer has a qualification, capacity or independence conflict",
      );
  }
  if (reviewerCode === raterCode || reviewerCode === rater.managerCode)
    fail(
      "REVIEWER_CONFLICT",
      "Reviewer must be independent of the rater and the rater’s manager",
    );
  if ((input.raterCode || input.reviewerCode) && !input.selectionReason?.trim())
    fail("SELECTION_REASON", "Record the reason for an explicit selection");
  const existing = await tx.assessmentAssignment.findMany({
    where: {
      tenantId: env.tenantId,
      employeeCode: input.employeeCode,
      state: {
        notIn: ["PUBLISHED", "REVOKED", "SUPERSEDED", "CLOSED_INCOMPLETE"],
      },
    },
  });
  if (existing.some((a) => a.taskCodes.some((c) => selected.includes(c))))
    fail(
      "DUPLICATE_ASSESSMENT",
      "An open assessment already covers one or more selected tasks",
      409,
    );
  const result = await tx.assessmentAssignment.create({
    data: {
      tenantId: env.tenantId,
      employeeCode: input.employeeCode,
      profileRef: profile.id,
      profileSnapshot: json({
        ...profile.definition,
        guideRef: profile.guideRef,
        tasks: tasks.filter((t) => selected.includes(t.taskCode)),
        requirements: profile.definition.requirements.filter((r) =>
          selected.includes(r.taskCode),
        ),
      }),
      policySnapshot: cfg.policy,
      purpose: input.purpose,
      period: input.period,
      raterCode,
      reviewerCode,
      taskCodes: selected,
      dueAt: new Date(input.dueAt),
      idempotencyKey: input.idempotencyKey,
      inputDigest: digest,
      holdUntil: automated
        ? new Date(env.now.getTime() + cfg.policy.holdHours * 3600000)
        : null,
    },
  });
  await audit(tx, env, "ASSIGN", result.id, input, result, {
    automated,
    selection,
  });
  await event(tx, env, "hr.assessment.assigned.v1", result.id, {
    employeeCode: result.employeeCode,
    assessmentRef: result.id,
    raterCode,
    reviewerCode,
    holdUntil: result.holdUntil,
  });
  return result;
}
export const assign = (raw) => {
  const input = AssignmentCommand.parse(raw);
  return run("hr.assessment.create", (tx, env) =>
    createAssignment(tx, env, input),
  );
};

export async function calculateVelocity(
  tx,
  env,
  a,
  task,
  command,
  qualityStatus,
  criticalFailure,
  links,
) {
  if (command?.notApplicable)
    return { status: "NOT_APPLICABLE", score: null, ...command.notApplicable };
  const refs = command?.timingSampleRefs || [];
  const samples = await tx.assessmentTimingSample.findMany({
    where: {
      tenantId: env.tenantId,
      id: { in: refs },
      employeeCode: a.employeeCode,
      taskCode: task.taskCode,
      taskVersion: task.taskVersion,
      withdrawnAt: null,
    },
  });
  if (samples.length !== new Set(refs).size)
    fail(
      "TIMING_SCOPE",
      "Timing samples must belong to this employee and task",
    );
  const bp = task.benchmarkPolicy;
  const eligible = samples.filter(
    (s) =>
      links.some(
        (l) =>
          (l.ref || l.evidenceRef) === s.evidenceRef &&
          l.state === "CONFIRMED" &&
          l.contributionConfirmed &&
          l.acceptanceConfirmed,
      ) &&
      s.capturedAt >=
        new Date(env.now.getTime() - days(task.evidencePolicy.freshnessDays)) &&
      bp &&
      s.unit === bp.unit &&
      s.clockBasis === bp.clockBasis &&
      s.complexity === task.complexity &&
      s.technology === task.technology,
  );
  const contexts = new Set(eligible.map((s) => s.context));
  const benchmark =
    contexts.size === 1
      ? await tx.assessmentBenchmark.findFirst({
          where: {
            tenantId: env.tenantId,
            taskCode: task.taskCode,
            taskVersion: task.taskVersion,
            status: "APPROVED",
            context: [...contexts][0],
            unit: bp.unit,
            clockBasis: bp.clockBasis,
            complexity: task.complexity,
            technology: task.technology,
            effectiveFrom: { lte: env.now },
            reviewAt: { gt: env.now },
          },
          orderBy: { version: "desc" },
        })
      : null;
  const confirmedRefs = links
    .filter(
      (l) =>
        l.state === "CONFIRMED" &&
        l.contributionConfirmed &&
        l.acceptanceConfirmed,
    )
    .map((l) => l.ref || l.evidenceRef);
  const opportunityEvidence = await tx.assessmentEvidence.findMany({
    where: {
      tenantId: env.tenantId,
      employeeCode: a.employeeCode,
      id: { in: confirmedRefs },
      withdrawnAt: null,
      scanState: "CLEAN",
      expiresAt: { gt: env.now },
    },
  });
  const result = velocity({
    samples: contexts.size > 1 ? [] : eligible,
    benchmark,
    qualityStatus,
    criticalFailure,
    opportunity: opportunityEvidence.some(
      (e) => e.taskCodes.includes(task.taskCode) && !e.integrityFlags.length,
    ),
    methodVerified: command?.methodVerified,
    methodNote: command?.methodNote,
  });
  const calculation = json({ ...result, inputRefs: refs, evaluatedAt: null });
  return {
    ...result,
    evidenceRefs:
      result.score === 0
        ? opportunityEvidence.map((e) => e.id)
        : [...new Set(eligible.map((s) => s.evidenceRef))],
    rationale:
      "Calculated from confirmed attributable timing or observed failure",
    calculation,
    digest: hash(calculation),
  };
}
export async function saveObservation(raw) {
  const input = ObservationCommand.parse(raw);
  return run("hr.assessment.update", async (tx, env) => {
    const a = await tx.assessmentAssignment.findFirst({
      where: { tenantId: env.tenantId, id: input.assessmentRef },
    });
    assignmentAccess(env, a, true);
    await verifyAssessmentScope(tx, env, a);
    await verifyCurrentAssessor(tx, env, a, env.who.employeeCode);
    if (!["ASSIGNED", "IN_PROGRESS", "RETURNED"].includes(a.state))
      fail("FROZEN_REVISION", "Only an open revision may be edited", 409);
    if (a.employeeCode !== input.employeeCode)
      fail("EMPLOYEE_MISMATCH", "Employee code does not match the assignment");
    const task = a.profileSnapshot.tasks.find(
      (t) =>
        t.taskCode === input.taskCode && t.taskVersion === input.taskVersion,
    );
    if (!task)
      fail("TASK_OUT_OF_SCOPE", "Task version is outside this assessment");
    const b = await brief(tx, env, a, input.taskCode);
    if (b.digest !== input.evidenceBriefDigest)
      fail(
        "BRIEF_CHANGED",
        "Evidence changed; refresh and verify the brief",
        409,
      );
    if (
      input.evidenceLinks.some((l) => !b.evidence.some((e) => e.id === l.ref))
    )
      fail(
        "EVIDENCE_SCOPE",
        "Evidence is not visible in the current brief",
        403,
      );
    const evidence = await tx.assessmentEvidence.findMany({
      where: {
        tenantId: env.tenantId,
        employeeCode: a.employeeCode,
        id: { in: b.evidence.map((e) => e.id) },
      },
    });
    if (
      evidence.some(
        (e) =>
          input.evidenceLinks.some(
            (l) => l.ref === e.id && l.state === "CONFIRMED",
          ) &&
          [a.raterCode, a.reviewerCode].includes(e.attribution?.caseAuthorCode),
      )
    )
      fail(
        "CASE_AUTHOR_CONFLICT",
        "A rater or reviewer authored a confirmed practical case; select independent assessors",
      );
    const decisions = {
      K: input.knowledge || {
        status: "PENDING",
        score: null,
        reasonCode: "NO_OPPORTUNITY",
      },
      S: input.skill || {
        status: "PENDING",
        score: null,
        reasonCode: "NO_OPPORTUNITY",
      },
    };
    const computed = await calculateVelocity(
      tx,
      env,
      a,
      task,
      input.velocity,
      input.qualityStatus,
      input.criticalFailure,
      input.evidenceLinks,
    );
    if (
      computed.status === "RATED" &&
      input.velocity?.confirmCalculatedResult &&
      input.velocity.calculationDigest !== computed.digest
    )
      fail(
        "CALCULATION_CHANGED",
        "Review the current calculated velocity before confirming it",
        409,
      );
    decisions.V =
      computed.status === "RATED" && !input.velocity?.confirmCalculatedResult
        ? { status: "PENDING", score: null, reasonCode: "EVIDENCE_REVIEW" }
        : computed;
    for (const d of ["K", "S", "V"]) {
      const errors = validateDecision({
        dimension: d,
        decision: decisions[d],
        task,
        evidence,
        links: input.evidenceLinks,
        now: env.now,
        criticalFailure: input.criticalFailure,
        criticalExceptionReason: input.criticalExceptionReason,
      });
      if (errors.length) fail("RATING_EVIDENCE", `${d}: ${errors.join("; ")}`);
    }
    await cas(tx, "assessmentAssignment", a, input.expectedVersion, {
      state: "IN_PROGRESS",
    });
    const key = {
      tenantId_assessmentRef_revisionNo_taskCode: {
        tenantId: env.tenantId,
        assessmentRef: a.id,
        revisionNo: a.revisionNo,
        taskCode: input.taskCode,
      },
    };
    let draftMeta = input.draftedNote;
    if (draftMeta?.kept) {
      const suggestion = await tx.assessmentIntegration.findUnique({
        where: {
          tenantId_kind_key: {
            tenantId: env.tenantId,
            kind: "NOTE_DRAFT",
            key: `${a.id}:${a.revisionNo}:${input.taskCode}:${input.evidenceBriefDigest}`,
          },
        },
      });
      if (!suggestion || suggestion.payload.version !== draftMeta.version)
        fail(
          "DRAFT_PROVENANCE",
          "Refresh the factual note suggestion before retaining it",
        );
      draftMeta = {
        ...draftMeta,
        edited: input.observationNote !== suggestion.payload.text,
      };
    }
    const data = {
      taskVersion: input.taskVersion,
      employeeCode: a.employeeCode,
      qualityStatus: input.qualityStatus,
      criticalFailure: input.criticalFailure,
      criticalExceptionReason: input.criticalExceptionReason,
      observationNote: input.observationNote,
      evidenceBriefDigest: input.evidenceBriefDigest,
      ...(draftMeta ? { draftedNote: draftMeta } : {}),
      timingRefs: input.velocity?.timingSampleRefs || [],
      velocityInput: json(input.velocity || {}),
      durationSeconds: input.durationSeconds,
      assessorCode: env.who.employeeCode,
      observedAt: env.now,
    };
    const o = await tx.assessmentObservation.upsert({
      where: key,
      create: {
        tenantId: env.tenantId,
        assessmentRef: a.id,
        revisionNo: a.revisionNo,
        taskCode: input.taskCode,
        ...data,
      },
      update: data,
    });
    await tx.assessmentEvidenceLink.deleteMany({
      where: {
        tenantId: env.tenantId,
        assessmentRef: a.id,
        revisionNo: a.revisionNo,
        taskCode: input.taskCode,
      },
    });
    if (input.evidenceLinks.length)
      await tx.assessmentEvidenceLink.createMany({
        data: input.evidenceLinks.map(({ ref, ...l }) => ({
          tenantId: env.tenantId,
          assessmentRef: a.id,
          revisionNo: a.revisionNo,
          taskCode: input.taskCode,
          evidenceRef: ref,
          ...l,
          confirmedByCode: env.who.employeeCode,
        })),
      });
    for (const [dimension, decision] of Object.entries(decisions)) {
      const expiries = (decision.evidenceRefs || [])
        .map((ref) => evidence.find((e) => e.id === ref)?.expiresAt?.getTime())
        .filter(Boolean);
      const data = {
        status: decision.status,
        score: decision.score,
        reasonCode: decision.reasonCode || null,
        rationale: decision.rationale || null,
        evidenceRefs: decision.evidenceRefs || [],
        ...(decision.behaviorCheck
          ? { behaviorCheck: decision.behaviorCheck }
          : {}),
        ...(decision.calculation
          ? { calculation: json(decision.calculation) }
          : {}),
        expiresAt:
          decision.status === "RATED"
            ? new Date(
                Math.min(
                  env.now.getTime() + days(task.evidencePolicy.expiryDays),
                  ...expiries,
                ),
              )
            : null,
      };
      await tx.assessmentDimension.upsert({
        where: {
          tenantId_observationRef_dimension: {
            tenantId: env.tenantId,
            observationRef: o.id,
            dimension,
          },
        },
        create: {
          tenantId: env.tenantId,
          observationRef: o.id,
          dimension,
          ...data,
        },
        update: data,
      });
    }
    if (input.criticalFailure)
      await restrict(
        tx,
        env,
        a.employeeCode,
        input.taskCode,
        "CRITICAL_FAILURE",
        o.id,
      );
    await audit(
      tx,
      env,
      "OBSERVATION_SAVE",
      a.id,
      input,
      { observationRef: o.id, version: a.version + 1 },
      { briefDigest: b.digest, draft: input.draftedNote || null },
    );
    return {
      observationRef: o.id,
      version: a.version + 1,
      decisions,
      calculatedVelocity: computed,
    };
  });
}
export async function snapshot(tx, env, a) {
  const observations = await tx.assessmentObservation.findMany({
    where: {
      tenantId: env.tenantId,
      assessmentRef: a.id,
      revisionNo: a.revisionNo,
    },
  });
  const dimensions = await tx.assessmentDimension.findMany({
    where: {
      tenantId: env.tenantId,
      observationRef: { in: observations.map((o) => o.id) },
    },
  });
  const links = await tx.assessmentEvidenceLink.findMany({
    where: {
      tenantId: env.tenantId,
      assessmentRef: a.id,
      revisionNo: a.revisionNo,
    },
  });
  const evidence = await tx.assessmentEvidence.findMany({
    where: {
      tenantId: env.tenantId,
      id: {
        in: links
          .filter((l) => l.state === "CONFIRMED")
          .map((l) => l.evidenceRef),
      },
    },
  });
  const complete = observations.map((o) => ({
    ...o,
    dimensions: dimensions.filter((d) => d.observationRef === o.id),
  }));
  const checks = [];
  if (
    evidence.some((e) =>
      [a.raterCode, a.reviewerCode].includes(e.attribution?.caseAuthorCode),
    )
  )
    checks.push(
      "Practical case author conflicts with the assigned rater or reviewer",
    );
  for (const t of a.profileSnapshot.tasks) {
    const o = complete.find((o) => o.taskCode === t.taskCode);
    if (!o || o.dimensions.length !== 3) {
      checks.push(
        `${t.taskCode}: record every applicable dimension or pending reason`,
      );
      continue;
    }
    for (const d of o.dimensions) {
      checks.push(
        ...validateDecision({
          dimension: d.dimension,
          decision: d,
          task: t,
          evidence,
          links: links.filter((l) => l.taskCode === t.taskCode),
          now: env.now,
          criticalFailure: o.criticalFailure,
          criticalExceptionReason: o.criticalExceptionReason,
        }).map((e) => `${t.taskCode}/${d.dimension}: ${e}`),
      );
    }
  }
  return {
    employeeCode: a.employeeCode,
    profile: a.profileSnapshot,
    observations: complete,
    links,
    evidenceManifest: evidence.map((e) => ({
      ref: e.id,
      contentHash: e.contentHash,
      sourceVersion: e.sourceVersion,
      withdrawnAt: e.withdrawnAt,
      expiresAt: e.expiresAt,
    })),
    checks,
    summaries: Object.fromEntries(
      ["K", "S", "V"].map((d) => [
        d,
        coverage(dimensions.filter((x) => x.dimension === d)),
      ]),
    ),
  };
}
async function copyRevision(tx, env, a) {
  const old = await snapshot(tx, env, a);
  for (const o of old.observations) {
    const { id, dimensions, tenantId, ...data } = o;
    const next = await tx.assessmentObservation.create({
      data: { ...data, tenantId: env.tenantId, revisionNo: a.revisionNo + 1 },
    });
    for (const d of dimensions) {
      const { id: ignored, ...fields } = d;
      await tx.assessmentDimension.create({
        data: { ...fields, observationRef: next.id },
      });
    }
  }
  for (const l of old.links) {
    const { id, ...data } = l;
    await tx.assessmentEvidenceLink.create({
      data: { ...data, revisionNo: a.revisionNo + 1 },
    });
  }
}
export async function reassignAssessment(tx, env, a, selection = {}) {
  const employee = await identity(tx, env.tenantId, a.employeeCode);
  const families = [
    ...new Set(a.profileSnapshot.tasks.map((t) => t.familyCode)),
  ];
  const cfg = await config(tx, env.tenantId);
  const candidates = await qualifiedCandidates(
    tx,
    env,
    employee,
    families,
    !env.who.employeeCode
      ? {
          dueAt: new Date(
            Math.max(+a.dueAt, +env.now + days(14)),
          ).toISOString(),
          policy: cfg.policy,
          minutes: a.taskCodes.length * cfg.policy.raterTaskMinutes,
        }
      : null,
  );
  const filtered = candidates.filter(
    (p) =>
      (a.state !== "DISPUTED" ||
        ![a.raterCode, a.reviewerCode, a.employeeCode].includes(
          p.employeeCode,
        )) &&
      a.profileSnapshot.tasks.every((t) =>
        p.qualifications.some(
          (q) =>
            q.familyCode === t.familyCode &&
            (q.scopes.includes(t.scope) || q.scopes.includes("*")),
        ),
      ),
  );
  const chosen = chooseRaters({
    employee,
    candidates: filtered,
    familyCodes: families,
    now: env.now,
    maxOpen: a.policySnapshot.raterMaxOpen,
  });
  const raterCode = selection.raterCode || chosen.raterCode,
    reviewerCode = selection.reviewerCode || chosen.reviewerCode;
  const rater = filtered.find((p) => p.employeeCode === raterCode),
    reviewer = filtered.find((p) => p.employeeCode === reviewerCode);
  const valid = (p) =>
    p &&
    !p.onLeave &&
    p.employeeCode !== a.employeeCode &&
    p.managerCode !== a.employeeCode &&
    p.openCount < a.policySnapshot.raterMaxOpen &&
    families.every((f) =>
      p.qualifications.some(
        (q) =>
          q.familyCode === f &&
          q.expiresAt > env.now &&
          q.calibration.passed &&
          !q.flags.includes("DISQUALIFIED"),
      ),
    );
  if (
    !valid(rater) ||
    !valid(reviewer) ||
    raterCode === reviewerCode ||
    rater.managerCode === reviewerCode
  )
    fail(
      "NO_QUALIFIED_REVIEWER",
      "No independent qualified replacement is available",
    );
  if (raterCode === a.raterCode && reviewerCode === a.reviewerCode)
    fail("REASSIGNMENT_UNCHANGED", "Choose a replacement rater or reviewer");
  await tx.assessmentRevision.updateMany({
    where: {
      tenantId: env.tenantId,
      assessmentRef: a.id,
      revisionNo: a.revisionNo,
      state: { in: ["SUBMITTED", "APPROVED"] },
    },
    data: { state: "RETURNED" },
  });
  return {
    raterCode,
    reviewerCode,
    revisionNo: a.revisionNo + 1,
    state: "RETURNED",
    stageStartedAt: env.now,
  };
}
export async function workflow(raw) {
  const input = WorkflowCommand.parse(raw);
  const permissions = {
    SUBMIT: "update",
    RETURN: "approve",
    APPROVE: "approve",
    ACKNOWLEDGE: "self",
    DISPUTE: "self",
    RESOLVE_DISPUTE: "approve",
    PUBLISH: "release",
    REVOKE: "revoke",
    CLOSE_INCOMPLETE: "approve",
    PULL_FULL: "approve",
    REASSIGN: "create",
  };
  return run(`hr.assessment.${permissions[input.action]}`, async (tx, env) => {
    const a = await tx.assessmentAssignment.findFirst({
      where: { tenantId: env.tenantId, id: input.assessmentRef },
    });
    assignmentAccess(env, a);
    if (input.expectedVersion !== a.version)
      fail("STALE_VERSION", "Reload the assessment before acting", 409);
    if (["SUBMIT", "APPROVE", "PUBLISH"].includes(input.action))
      await verifyAssessmentScope(tx, env, a);
    let revision = await tx.assessmentRevision.findFirst({
      where: {
        tenantId: env.tenantId,
        assessmentRef: a.id,
        revisionNo: a.revisionNo,
      },
    });
    let nextState = a.state,
      nextRevision = a.revisionNo,
      actorChanges = {};
    const reviewerActions = [
      "APPROVE",
      "RETURN",
      "PULL_FULL",
      "CLOSE_INCOMPLETE",
    ];
    if (
      reviewerActions.includes(input.action) &&
      (a.reviewerCode !== env.who.employeeCode ||
        env.who.employeeCode === a.employeeCode ||
        env.who.employeeCode === a.raterCode)
    )
      fail(
        "REVIEWER_REQUIRED",
        "Only the independent assigned reviewer can perform this action",
        403,
      );
    if (
      ["ACKNOWLEDGE", "DISPUTE"].includes(input.action) &&
      !(env.who.historicalCodes || [env.who.employeeCode]).includes(
        a.employeeCode,
      )
    )
      fail(
        "EMPLOYEE_REQUIRED",
        "Only the assessed employee can acknowledge or dispute",
        403,
      );
    if (!input.declaration?.trim())
      fail("ATTESTATION_REQUIRED", "A deliberate declaration is required");
    if (
      input.action !== "SUBMIT" &&
      revision &&
      input.revisionDigest !== revision.digest
    )
      fail(
        "REVISION_CHANGED",
        "The declaration must bind to the current frozen revision",
        409,
      );
    if (input.action === "SUBMIT") {
      assignmentAccess(env, a, true);
      if (!["ASSIGNED", "IN_PROGRESS", "RETURNED"].includes(a.state))
        fail("INVALID_STATE", "Only open assessments may be submitted");
      await verifyCurrentAssessor(tx, env, a, a.raterCode);
      const snap = await snapshot(tx, env, a);
      if (snap.checks.length) fail("PREFLIGHT_FAILED", snap.checks.join("; "));
      const evidence = await tx.assessmentEvidence.findMany({
        where: {
          tenantId: env.tenantId,
          id: { in: snap.evidenceManifest.map((e) => e.ref) },
        },
      });
      const q = await tx.assessmentQualification.findFirst({
        where: { tenantId: env.tenantId, employeeCode: a.raterCode },
      });
      const risk = reviewTier({
        tasks: a.profileSnapshot.tasks,
        observations: snap.observations,
        evidence,
        qualification: q,
        purpose: a.purpose,
        policy: a.policySnapshot,
        sampleValue: parseInt(hash(a.id).slice(0, 8), 16) / 0x100000000,
      });
      revision = await tx.assessmentRevision.create({
        data: {
          tenantId: env.tenantId,
          assessmentRef: a.id,
          revisionNo: a.revisionNo,
          snapshot: json(snap),
          digest: hash(snap),
          checksDigest: hash(snap.checks),
          reviewTier: risk.tier,
          sampled: risk.tier !== "BATCH",
        },
      });
      nextState = "UNDER_REVIEW";
    } else if (input.action === "APPROVE") {
      if (a.state !== "UNDER_REVIEW")
        fail("INVALID_STATE", "Assessment is not awaiting review");
      await verifyCurrentAssessor(tx, env, a, a.reviewerCode);
      const fresh = await snapshot(tx, env, a);
      if (fresh.checks.length || hash(fresh) !== revision.digest)
        fail(
          "EVIDENCE_CHANGED",
          "Evidence changed after submission; return the assessment",
        );
      if (
        revision.reviewTier !== "BATCH" &&
        a.taskCodes.some((t) => !input.reviewedTaskCodes?.includes(t))
      )
        fail("FULL_REVIEW_REQUIRED", "Explicitly review every task");
      if (
        fresh.observations.some(
          (o) => o.criticalFailure && o.criticalExceptionReason,
        ) &&
        !input.declaration.includes("critical exception")
      )
        fail(
          "CRITICAL_EXCEPTION_REVIEW",
          "Explicitly attest to acceptance of the critical exception",
        );
      await tx.assessmentRevision.update({
        where: { id: revision.id },
        data: { state: "APPROVED", approvedAt: env.now },
      });
      nextState = "ACKNOWLEDGMENT_DUE";
    } else if (input.action === "PULL_FULL") {
      if (a.state !== "UNDER_REVIEW")
        fail("INVALID_STATE", "Assessment is not awaiting review");
      await tx.assessmentRevision.update({
        where: { id: revision.id },
        data: { reviewTier: "FULL", sampled: true },
      });
    } else if (input.action === "RETURN") {
      if (
        !["UNDER_REVIEW", "ACKNOWLEDGMENT_DUE"].includes(a.state) ||
        !input.reason?.trim()
      )
        fail(
          "RETURN_REASON",
          "Return requires a reviewable assessment and reason",
        );
      await copyRevision(tx, env, a);
      nextRevision++;
      nextState = "RETURNED";
      await tx.assessmentRevision.update({
        where: { id: revision.id },
        data: { state: "RETURNED" },
      });
    } else if (input.action === "ACKNOWLEDGE") {
      if (a.state !== "ACKNOWLEDGMENT_DUE")
        fail("INVALID_STATE", "Assessment is not awaiting acknowledgment");
      nextState = "ACKNOWLEDGED";
    } else if (input.action === "DISPUTE") {
      if (
        !["ACKNOWLEDGMENT_DUE", "ACKNOWLEDGED", "PUBLISHED"].includes(
          a.state,
        ) ||
        !input.reason?.trim()
      )
        fail(
          "DISPUTE_REASON",
          "A reason and an approved revision are required",
        );
      for (const taskCode of input.taskCodes?.length
        ? input.taskCodes
        : a.taskCodes) {
        if (!a.taskCodes.includes(taskCode))
          fail("TASK_OUT_OF_SCOPE", "Disputed task is outside this assessment");
        await restrict(tx, env, a.employeeCode, taskCode, "DISPUTE", a.id);
      }
      await exception(tx, env, `dispute:${a.id}`, "DISPUTE", a.id, {
        employeeCode: a.employeeCode,
        reason: input.reason,
        reviewerMustExclude: [a.raterCode, a.reviewerCode, a.employeeCode],
      });
      nextState = "DISPUTED";
    } else if (input.action === "RESOLVE_DISPUTE") {
      if (
        a.state !== "DISPUTED" ||
        [a.employeeCode, a.raterCode, a.reviewerCode].includes(
          env.who.employeeCode,
        ) ||
        !input.reason?.trim()
      )
        fail(
          "INDEPENDENT_DISPUTE_REVIEW",
          "An independent reviewer and reason are required",
        );
      await verifyCurrentAssessor(tx, env, a, env.who.employeeCode);
      actorChanges = {
        ...(await reassignAssessment(tx, env, a)),
        purpose: "DISPUTE",
      };
      nextRevision = actorChanges.revisionNo;
      nextState = "RETURNED";
    } else if (input.action === "PUBLISH") {
      if (
        env.who.employeeCode === a.employeeCode ||
        env.who.employeeCode === a.raterCode
      )
        fail(
          "SEPARATION_REQUIRED",
          "Release requires an independent authorized person",
          403,
        );
      if (a.state !== "ACKNOWLEDGED") {
        const approval =
          input.acknowledgmentExceptionRef &&
          (await tx.assessmentException.findFirst({
            where: {
              tenantId: env.tenantId,
              id: input.acknowledgmentExceptionRef,
              scopeRef: a.id,
              kind: "ACKNOWLEDGMENT_EXCEPTION",
              status: "APPROVED",
            },
          }));
        if (
          a.state !== "ACKNOWLEDGMENT_DUE" ||
          !approval ||
          approval.detail.approvedByCode === env.who.employeeCode
        )
          fail(
            "ACKNOWLEDGMENT_REQUIRED",
            "Employee acknowledgment or a separately approved exception is required",
          );
      }
      const fresh = await snapshot(tx, env, a);
      if (fresh.checks.length || hash(fresh) !== revision.digest)
        fail(
          "EVIDENCE_CHANGED",
          "Evidence changed; return the revision before publication",
        );
      await consumeApproval(tx, env.tenantId, "ASSESSMENT_RELEASE", `${a.id}@${a.revisionNo}`);
      const latest = await tx.assessmentCapability.findFirst({
        where: { tenantId: env.tenantId, employeeCode: a.employeeCode },
        orderBy: { sequence: "desc" },
      });
      const sequence = (latest?.sequence || 0) + 1;
      for (const o of fresh.observations)
        for (const d of o.dimensions) {
          const task = a.profileSnapshot.tasks.find(
              (t) => t.taskCode === o.taskCode,
            ),
            scope = scopeKey(task);
          const current = await tx.assessmentCapability.findUnique({
            where: {
              tenantId_employeeCode_taskCode_scopeKey_dimension: {
                tenantId: env.tenantId,
                employeeCode: a.employeeCode,
                taskCode: o.taskCode,
                scopeKey: scope,
                dimension: d.dimension,
              },
            },
          });
          if (current && current.revisionRef !== revision.id) {
            const previous = await tx.assessmentRevision.findFirst({
              where: { tenantId: env.tenantId, id: current.revisionRef },
            });
            const lastObserved = previous?.snapshot?.observations?.find(
              (x) => x.taskCode === o.taskCode,
            )?.observedAt;
            if (lastObserved && new Date(lastObserved) > new Date(o.observedAt))
              fail(
                "NEWER_OBSERVATION_EXISTS",
                "A newer observation is already published for this task; reassess or close the superseded draft",
              );
          }
          const held = await tx.assessmentRestriction.findFirst({
            where: {
              tenantId: env.tenantId,
              employeeCode: a.employeeCode,
              taskCode: o.taskCode,
              liftedAt: null,
            },
          });
          const data = {
            taskVersion: o.taskVersion,
            status: held ? "HELD" : d.status === "RATED" ? "CURRENT" : d.status,
            score: d.score,
            revisionRef: revision.id,
            sequence,
            expiresAt: d.expiresAt || env.now,
            publishedAt: env.now,
          };
          await tx.assessmentCapability.upsert({
            where: {
              tenantId_employeeCode_taskCode_scopeKey_dimension: {
                tenantId: env.tenantId,
                employeeCode: a.employeeCode,
                taskCode: o.taskCode,
                scopeKey: scope,
                dimension: d.dimension,
              },
            },
            create: {
              tenantId: env.tenantId,
              employeeCode: a.employeeCode,
              taskCode: o.taskCode,
              scopeKey: scope,
              dimension: d.dimension,
              ...data,
            },
            update: data,
          });
        }
      await tx.assessmentRevision.update({
        where: { id: revision.id },
        data: { state: "PUBLISHED", publishedAt: env.now, sequence },
      });
      await publishDownstream(tx, env, a, revision, fresh, sequence);
      await event(tx, env, "hr.assessment.published.v1", a.id, {
        employeeCode: a.employeeCode,
        assessmentRef: a.id,
        revisionRef: revision.id,
        revisionDigest: revision.digest,
        sequence,
        capabilities: await tx.assessmentCapability.findMany({
          where: { tenantId: env.tenantId, employeeCode: a.employeeCode },
        }),
        restrictions: await tx.assessmentRestriction.findMany({
          where: {
            tenantId: env.tenantId,
            employeeCode: a.employeeCode,
            liftedAt: null,
          },
        }),
      });
      nextState = "PUBLISHED";
    } else if (input.action === "REVOKE") {
      if (a.state !== "PUBLISHED" || !input.reason?.trim())
        fail(
          "INVALID_STATE",
          "Only a published revision may be revoked with a reason",
        );
      for (const taskCode of a.taskCodes)
        await restrict(tx, env, a.employeeCode, taskCode, "REVOCATION", a.id);
      await tx.assessmentRevision.update({
        where: { id: revision.id },
        data: { state: "REVOKED" },
      });
      nextState = "REVOKED";
      const inputs = await tx.assessmentAppraisalInput.findMany({
        where: { tenantId: env.tenantId, revisionRef: revision.id },
      });
      for (const prior of inputs)
        await tx.assessmentIntegration.upsert({
          where: {
            tenantId_kind_key: {
              tenantId: env.tenantId,
              kind: "APPRAISAL_AMENDMENT",
              key: `revoked:${prior.id}`,
            },
          },
          create: {
            tenantId: env.tenantId,
            employeeCode: a.employeeCode,
            kind: "APPRAISAL_AMENDMENT",
            key: `revoked:${prior.id}`,
            sourceRef: revision.id,
            targetRef: String(prior.cycleId),
            status: "REQUIRES_APPRAISER_REVIEW",
            payload: {
              originalInputRef: prior.id,
              reason: input.reason,
              revisionDigest: revision.digest,
              revokedAt: env.now.toISOString(),
              preserveFinalizedAppraisal: true,
            },
          },
          update: {},
        });
    } else if (input.action === "CLOSE_INCOMPLETE") {
      if (["PUBLISHED", "REVOKED"].includes(a.state) || !input.reason?.trim())
        fail(
          "INVALID_STATE",
          "Record a reason for closing an unpublished assessment",
        );
      nextState = "CLOSED_INCOMPLETE";
    } else if (input.action === "REASSIGN") {
      if (
        ["PUBLISHED", "REVOKED", "SUPERSEDED", "CLOSED_INCOMPLETE"].includes(
          a.state,
        ) ||
        !input.reason?.trim()
      )
        fail(
          "INVALID_STATE",
          "Only open assessments can be reassigned with a reason",
        );
      actorChanges = await reassignAssessment(tx, env, a, input);
      nextState = actorChanges.state;
      nextRevision = actorChanges.revisionNo;
    }
    const result = await cas(
      tx,
      "assessmentAssignment",
      a,
      input.expectedVersion,
      {
        ...actorChanges,
        state: nextState,
        revisionNo: nextRevision,
        stageStartedAt: env.now,
      },
    );
    await tx.assessmentSignOff.create({
      data: {
        tenantId: env.tenantId,
        assessmentRef: a.id,
        revisionNo: a.revisionNo,
        action: input.action,
        employeeCode: env.who.employeeCode,
        actorPrincipal: env.who.principal,
        digest: revision?.digest || hash(a),
        attestation: input.declaration,
        reason: input.reason,
        metadata: {
          attestationVersion: 1,
          reviewedTaskCodes: input.reviewedTaskCodes || [],
          revisionNo: a.revisionNo,
        },
      },
    });
    await audit(tx, env, input.action, a.id, input, result);
    if (["SUBMIT", "APPROVE", "REVOKE"].includes(input.action))
      await event(
        tx,
        env,
        `hr.assessment.${{ SUBMIT: "submitted", APPROVE: "reviewed", REVOKE: "revoked" }[input.action]}.v1`,
        a.id,
        {
          employeeCode: a.employeeCode,
          assessmentRef: a.id,
          revisionRef: revision.id,
          revisionDigest: revision.digest,
        },
      );
    return result;
  });
}
async function verifyCurrentAssessor(tx, env, a, employeeCode) {
  const employee = await identity(tx, env.tenantId, employeeCode);
  if (
    employee.employeeCode === a.employeeCode ||
    employee.managerCode === a.employeeCode
  )
    fail(
      "ASSESSOR_CONFLICT",
      "Current reporting relationships conflict with independent assessment",
      403,
    );
  const qualifications = await tx.assessmentQualification.findMany({
    where: { tenantId: env.tenantId, employeeCode, expiresAt: { gt: env.now } },
  });
  if (
    await tx.assessmentAssignment.findFirst({
      where: {
        tenantId: env.tenantId,
        employeeCode: a.employeeCode,
        state: "DISPUTED",
        OR: [{ raterCode: employeeCode }, { reviewerCode: employeeCode }],
      },
    })
  )
    fail(
      "ASSESSOR_CONFLICT",
      "An open dispute requires an independent assessor",
      403,
    );
  if (
    a.profileSnapshot.tasks.some(
      (t) =>
        !qualifications.some(
          (q) =>
            q.familyCode === t.familyCode &&
            q.calibration.passed &&
            !q.flags.includes("DISQUALIFIED") &&
            (q.scopes.includes(t.scope) || q.scopes.includes("*")),
        ),
    )
  )
    fail(
      "QUALIFICATION_EXPIRED",
      "Current calibrated scope qualification is required",
    );
}
