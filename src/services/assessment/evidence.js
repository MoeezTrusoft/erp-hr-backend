import { z } from "zod";
import {
  WorkEvidenceEvent,
  ManualCaseCommand,
  AssessmentRef,
  DraftedNote,
} from "@trusoft/contracts/assessment";
import {
  attributableTiming,
  benchmarkCandidate,
} from "@trusoft/contracts/assessment-rules";
import {
  run,
  config,
  fail,
  identity,
  audit,
  event,
  hash,
  json,
  days,
  exception,
  scopeKey,
} from "./base.js";

export async function restrict(
  tx,
  env,
  employeeCode,
  taskCode,
  cause,
  sourceRef,
) {
  const where = {
    tenantId_employeeCode_taskCode_cause_sourceRef: {
      tenantId: env.tenantId,
      employeeCode,
      taskCode,
      cause,
      sourceRef,
    },
  };
  const existing = await tx.assessmentRestriction.findUnique({ where });
  if (existing && !existing.liftedAt) return existing;
  const result = await tx.assessmentRestriction.upsert({
    where,
    create: {
      tenantId: env.tenantId,
      employeeCode,
      taskCode,
      cause,
      sourceRef,
    },
    update: { liftedAt: null, liftedByCode: null },
  });
  await tx.assessmentCapability.updateMany({
    where: { tenantId: env.tenantId, employeeCode, taskCode },
    data: { status: "HELD" },
  });
  await event(
    tx,
    env,
    cause === "CRITICAL_FAILURE"
      ? "hr.capability.restricted.v1"
      : "hr.capability.hold_raised.v1",
    result.id,
    { employeeCode, taskCode, cause, restrictionRef: result.id },
  );
  return result;
}
export async function invalidateEvidence(tx, env, evidence, reason) {
  for (const e of evidence) {
    await tx.assessmentEvidence.update({
      where: { id: e.id },
      data: { withdrawnAt: env.now, integrityFlags: [reason] },
    });
    await tx.assessmentTimingSample.updateMany({
      where: { tenantId: env.tenantId, evidenceRef: e.id },
      data: { withdrawnAt: env.now, comparable: false },
    });
    const links = await tx.assessmentEvidenceLink.findMany({
      where: { tenantId: env.tenantId, evidenceRef: e.id, state: "CONFIRMED" },
    });
    for (const link of links) {
      const a = await tx.assessmentAssignment.findFirst({
        where: { tenantId: env.tenantId, id: link.assessmentRef },
      });
      if (!a || a.revisionNo !== link.revisionNo) continue;
      if (["ASSIGNED", "IN_PROGRESS", "RETURNED"].includes(a.state)) {
        const obs = await tx.assessmentObservation.findFirst({
          where: {
            tenantId: env.tenantId,
            assessmentRef: a.id,
            revisionNo: a.revisionNo,
            taskCode: link.taskCode,
          },
        });
        if (obs)
          await tx.assessmentDimension.updateMany({
            where: { tenantId: env.tenantId, observationRef: obs.id },
            data: {
              status: "PENDING",
              score: null,
              reasonCode: "EVIDENCE_WITHDRAWN",
            },
          });
        await tx.assessmentAssignment.update({
          where: { id: a.id },
          data: { version: { increment: 1 } },
        });
      }
      await restrict(
        tx,
        env,
        e.employeeCode,
        link.taskCode,
        "EVIDENCE_WITHDRAWN",
        e.id,
      );
      await exception(
        tx,
        env,
        `evidence:${a.id}:${e.id}`,
        "EVIDENCE_WITHDRAWN",
        a.id,
        { evidenceRef: e.id, taskCode: link.taskCode, reason },
      );
    }
    await event(tx, env, "hr.evidence.withdrawn.v1", e.id, {
      employeeCode: e.employeeCode,
      evidenceRef: e.id,
      reason,
    });
  }
}
async function timingSamples(tx, env, evidence, timing, tasks) {
  if (!timing) return;
  const calculated = attributableTiming(timing);
  for (const task of tasks) {
    const data = {
      tenantId: env.tenantId,
      employeeCode: evidence.employeeCode,
      evidenceRef: evidence.id,
      caseRef: evidence.caseRef,
      taskCode: task.taskCode,
      taskVersion: task.taskVersion,
      origin: evidence.origin,
      unit: timing.unit,
      clockBasis:
        timing.individualEffortMinutes != null
          ? "PERSON_EFFORT"
          : timing.clockBasis,
      complexity: timing.complexity,
      technology: timing.technology,
      context: timing.context,
      attributableMinutes: calculated.attributableMinutes,
      elapsedMinutes: calculated.elapsedMinutes,
      waitMinutes: calculated.waitMinutes,
      acceptedUnits: timing.acceptedUnits,
      accepted: evidence.accepted,
      comparable: calculated.comparable,
      attempts: timing.attempts,
      reworkMinutes: timing.reworkMinutes,
      input: json(timing),
      capturedAt: evidence.captureAt,
    };
    await tx.assessmentTimingSample.create({ data });
  }
}
export async function processEvidenceEvent(tx, env, input) {
  const cfg = await config(tx, env.tenantId);
  const source = cfg.sourceRegister?.find(
    (s) => s.source === input.source && s.enabled,
  );
  if (!source || !source.classifications.includes(input.classification))
    fail(
      "SOURCE_UNAPPROVED",
      "Evidence source or classification is not approved",
    );
  const prior = await tx.assessmentEvidence.findMany({
    where: {
      tenantId: env.tenantId,
      source: input.source,
      sourceRecordId: input.sourceRecordId,
    },
  });
  if (prior.some((p) => p.sourceVersion > input.sourceVersion))
    return { ignored: "OLDER_VERSION" };
  if (input.action !== "ACCEPTED") {
    await invalidateEvidence(
      tx,
      env,
      prior.filter((p) => !p.withdrawnAt),
      input.action,
    );
    return { invalidated: prior.length };
  }
  if (
    prior.some(
      (p) =>
        p.sourceVersion === input.sourceVersion &&
        p.contentHash !== input.contentHash,
    )
  ) {
    await invalidateEvidence(tx, env, prior, "HASH_MISMATCH");
    await exception(
      tx,
      env,
      `source:${input.source}`,
      "CIRCUIT_BREAKER",
      input.source,
      { reason: "HASH_MISMATCH" },
      "SOURCE_OWNER",
    );
    return { quarantined: true };
  }
  const maps = source.mappings.filter(
    (m) =>
      m.workType === input.workType &&
      (!input.taskCodes.length || input.taskCodes.includes(m.taskCode)),
  );
  if (!maps.length) {
    await exception(
      tx,
      env,
      `unmapped:${input.source}:${input.workType}`,
      "UNMAPPED_WORK",
      input.source,
      { workType: input.workType },
      "CATALOG_OWNER",
    );
    return { unmapped: true };
  }
  const tasks = await tx.assessmentTaskVersion.findMany({
    where: {
      tenantId: env.tenantId,
      status: "PUBLISHED",
      OR: maps.map((m) => ({
        taskCode: m.taskCode,
        taskVersion: m.taskVersion,
      })),
    },
  });
  if (
    tasks.length !== maps.length ||
    new Set(maps.map((m) => m.method)).size !== 1
  )
    fail(
      "MAPPING_INCOMPLETE",
      "Every work-type mapping must resolve to a published task with the same evidence method",
    );
  await invalidateEvidence(
    tx,
    env,
    prior.filter(
      (p) => p.sourceVersion < input.sourceVersion && !p.withdrawnAt,
    ),
    "SOURCE_VERSION_CHANGED",
  );
  const result = [];
  for (const contributor of input.contributors) {
    await identity(tx, env.tenantId, contributor.employeeCode);
    if (
      prior.some(
        (p) =>
          p.sourceVersion === input.sourceVersion &&
          p.employeeCode === contributor.employeeCode,
      )
    )
      continue;
    const key = `${input.source}:${input.sourceRecordId}:${input.sourceVersion}:${contributor.employeeCode}`;
    const c = await tx.assessmentCase.create({
      data: {
        tenantId: env.tenantId,
        employeeCode: contributor.employeeCode,
        origin: "HARVESTED",
        title: `${input.source} / ${input.workType}`,
        taskCodes: tasks.map((t) => t.taskCode),
        context: {
          source: input.source,
          record: input.sourceRecordId,
          version: input.sourceVersion,
        },
        observedAt: new Date(input.occurredAt),
        idempotencyKey: key,
        inputDigest: hash(input),
      },
    });
    const e = await tx.assessmentEvidence.create({
      data: {
        tenantId: env.tenantId,
        caseRef: c.id,
        employeeCode: contributor.employeeCode,
        source: input.source,
        sourceRecordId: input.sourceRecordId,
        sourceVersion: input.sourceVersion,
        origin: "HARVESTED",
        method: maps[0].method,
        taskCodes: tasks
          .filter(
            (t) =>
              maps.find((m) => m.taskCode === t.taskCode)?.method ===
              maps[0].method,
          )
          .map((t) => t.taskCode),
        dimensions: ["K", "S", "V"],
        attribution: {
          employeeCode: contributor.employeeCode,
          role: contributor.role,
          authorshipVerified: input.executionVerified,
        },
        sourceRef: input.sourceRef,
        contentHash: input.contentHash,
        classification: input.classification,
        accepted:
          input.acceptanceVerified &&
          ["ACCEPTED", "REWORK_ACCEPTED"].includes(input.qualityStatus),
        executionVerified: input.executionVerified,
        substantive: input.substantive,
        nonroutine: input.nonroutine,
        qualityStatus: input.qualityStatus,
        scanState: "CLEAN",
        captureAt: new Date(input.occurredAt),
        expiresAt: new Date(
          Date.parse(input.occurredAt) + days(source.freshnessDays),
        ),
        retentionUntil: new Date(
          env.now.getTime() + days(cfg.policy.retentionDays),
        ),
      },
    });
    const timing = input.timing
      ? {
          ...input.timing,
          ...(contributor.individualEffortMinutes != null
            ? { individualEffortMinutes: contributor.individualEffortMinutes }
            : input.contributors.length > 1
              ? {
                  clockBasis: "TEAM_ELAPSED",
                  individualEffortMinutes: undefined,
                }
              : {}),
        }
      : null;
    await timingSamples(
      tx,
      env,
      e,
      timing,
      tasks.map((t) => t.definition),
    );
    await event(tx, env, "hr.evidence.harvested.v1", e.id, {
      employeeCode: e.employeeCode,
      evidenceRef: e.id,
      source: input.source,
    });
    result.push(e.id);
  }
  return { evidenceRefs: result };
}
export async function ingest(raw) {
  const input = WorkEvidenceEvent.parse(raw);
  return run(
    "hr.assessment_evidence.ingest",
    async (tx, env) => {
      if (input.companyUuid !== env.tenantId)
        fail(
          "COMPANY_MISMATCH",
          "The evidence company differs from the verified claim",
          403,
        );
      const cfg = await config(tx, env.tenantId),
        source = cfg.sourceRegister?.find(
          (s) => s.source === input.source && s.enabled,
        );
      if (!source || env.ctx.servicePrincipal !== source.servicePrincipal)
        fail(
          "SOURCE_IDENTITY",
          "Only the registered source principal may publish evidence",
          403,
        );
      const prior = await tx.assessmentInboxEvent.findFirst({
        where: { tenantId: env.tenantId, eventId: input.eventId },
      });
      if (prior) {
        if (hash(prior.payload) !== hash(input))
          fail(
            "IDEMPOTENCY_CONFLICT",
            "Event ID was reused with different content",
            409,
          );
        return { ref: prior.id, state: prior.status };
      }
      return tx.assessmentInboxEvent.create({
        data: {
          tenantId: env.tenantId,
          eventId: input.eventId,
          source: input.source,
          payload: json(input),
        },
      });
    },
    { requireActor: false },
  );
}
export async function createManualCase(raw) {
  const input = ManualCaseCommand.parse(raw);
  return run("hr.assessment_evidence.create", async (tx, env) => {
    await identity(tx, env.tenantId, input.employeeCode);
    if (input.employeeCode === env.who.employeeCode)
      fail(
        "SELF_EVIDENCE",
        "An assigned assessor must record practical evidence",
        403,
      );
    const assignment = await tx.assessmentAssignment.findFirst({
      where: {
        tenantId: env.tenantId,
        employeeCode: input.employeeCode,
        raterCode: env.who.employeeCode,
        state: { in: ["ASSIGNED", "IN_PROGRESS", "RETURNED"] },
      },
    });
    if (
      !assignment ||
      input.taskCodes.some((t) => !assignment.taskCodes.includes(t))
    )
      fail(
        "ASSESSOR_REQUIRED",
        "Create a case only within an assigned assessment scope",
        403,
      );
    const prior = await tx.assessmentCase.findFirst({
      where: { tenantId: env.tenantId, idempotencyKey: input.idempotencyKey },
    });
    if (prior) {
      if (prior.inputDigest !== hash(input))
        fail("IDEMPOTENCY_CONFLICT", "Case key reused", 409);
      return prior;
    }
    const cfg = await config(tx, env.tenantId);
    const tasks = assignment.profileSnapshot.tasks.filter((t) =>
      input.taskCodes.includes(t.taskCode),
    );
    if (
      (input.origin === "SIMULATION" ||
        input.method === "PRACTICAL_SIMULATION") &&
      !input.caseAuthorCode
    )
      fail(
        "CASE_AUTHOR_REQUIRED",
        "Identify the independent author of the controlled practical case",
      );
    if (input.caseAuthorCode) {
      await identity(tx, env.tenantId, input.caseAuthorCode);
      if (
        [
          assignment.raterCode,
          assignment.reviewerCode,
          assignment.employeeCode,
        ].includes(input.caseAuthorCode)
      )
        fail(
          "CASE_AUTHOR_CONFLICT",
          "The practical case author cannot be the subject, rater or reviewer",
        );
    }
    const c = await tx.assessmentCase.create({
      data: {
        tenantId: env.tenantId,
        employeeCode: input.employeeCode,
        origin: input.origin,
        title: input.title,
        taskCodes: input.taskCodes,
        context: {
          contribution: input.contribution,
          acceptanceNote: input.acceptanceNote,
          ...(input.caseAuthorCode
            ? { caseAuthorCode: input.caseAuthorCode }
            : {}),
        },
        createdByCode: env.who.employeeCode,
        observedAt: new Date(input.observedAt),
        idempotencyKey: input.idempotencyKey,
        inputDigest: hash(input),
      },
    });
    const e = await tx.assessmentEvidence.create({
      data: {
        tenantId: env.tenantId,
        caseRef: c.id,
        employeeCode: input.employeeCode,
        source: "ASSESSOR",
        sourceRecordId: c.id,
        sourceVersion: 1,
        origin: input.origin,
        method: input.method,
        taskCodes: input.taskCodes,
        dimensions: ["K", "S", "V"],
        attribution: {
          authorshipVerified: input.authorshipVerified,
          assessorCode: env.who.employeeCode,
          ...(input.caseAuthorCode
            ? { caseAuthorCode: input.caseAuthorCode }
            : {}),
        },
        sourceRef: input.sourceRef,
        contentHash: input.contentHash,
        classification: "CONFIDENTIAL",
        accepted: input.accepted,
        executionVerified: input.executionVerified,
        substantive: input.substantive,
        nonroutine: input.nonroutine,
        qualityStatus: input.qualityStatus,
        scanState: input.origin === "MANUAL_UPLOAD" ? "QUARANTINED" : "CLEAN",
        captureAt: new Date(input.observedAt),
        expiresAt: new Date(
          Date.parse(input.observedAt) +
            days(Math.min(...tasks.map((t) => t.evidencePolicy.freshnessDays))),
        ),
        retentionUntil: new Date(
          env.now.getTime() + days(cfg.policy.retentionDays),
        ),
      },
    });
    await timingSamples(tx, env, e, input.timing, tasks);
    await audit(tx, env, "MANUAL_CASE", c.id, input, {
      caseRef: c.id,
      evidenceRef: e.id,
    });
    return { ...c, evidenceRef: e.id, scanState: e.scanState };
  });
}
export async function brief(tx, env, assignment, taskCode) {
  const task = assignment.profileSnapshot.tasks.find(
    (t) => t.taskCode === taskCode,
  );
  if (!task)
    fail("TASK_OUT_OF_SCOPE", "Task is outside the approved assessment");
  const evidence = await tx.assessmentEvidence.findMany({
    where: {
      tenantId: env.tenantId,
      employeeCode: assignment.employeeCode,
      taskCodes: { array_contains: [taskCode] },
    },
    orderBy: { captureAt: "desc" },
    take: 200,
  });
  const cfg = await config(tx, env.tenantId);
  const visible = evidence.filter(
    (e) =>
      e.source === "ASSESSOR" ||
      env.ctx.user.isAdmin ||
      env.ctx.permissions.includes(
        cfg.sourceRegister?.find((s) => s.source === e.source)
          ?.sourcePermission,
      ),
  );
  // No source body, customer data or financial records enter an assessment brief.
  const items = visible.map((e) => ({
    id: e.id,
    caseRef: e.caseRef,
    employeeCode: e.employeeCode,
    source: e.source,
    sourceRef: e.sourceRef,
    method: e.method,
    origin: e.origin,
    dimensions: e.dimensions,
    accepted: e.accepted,
    executionVerified: e.executionVerified,
    qualityStatus: e.qualityStatus,
    captureAt: e.captureAt,
    expiresAt: e.expiresAt,
    withdrawnAt: e.withdrawnAt,
    scanState: e.scanState,
    integrityFlags: e.integrityFlags,
    substantive: e.substantive,
    nonroutine: e.nonroutine,
    contentHash: e.contentHash,
  }));
  const timing = await tx.assessmentTimingSample.findMany({
    where: {
      tenantId: env.tenantId,
      employeeCode: assignment.employeeCode,
      taskCode,
      evidenceRef: { in: visible.map((e) => e.id) },
    },
  });
  const data = {
    taskCode,
    evidence: items,
    timingSamples: json(timing),
    requirements: task.evidencePolicy,
  };
  return { ...data, digest: hash(data) };
}
export async function recordDraft(tx, env, assessmentRef, raw) {
  const parsed = DraftedNote.safeParse(raw);
  if (!parsed.success) {
    await exception(
      tx,
      env,
      `draft:${assessmentRef}`,
      "DRAFT_REJECTED",
      assessmentRef,
      { reason: "INVALID_OR_SCORE_BEARING" },
    );
    return { available: false };
  }
  await audit(
    tx,
    env,
    "EVIDENCE_NOTE_DRAFT",
    assessmentRef,
    { refs: parsed.data.evidenceRefs },
    parsed.data,
    {
      modelVersion: parsed.data.modelVersion,
      promptVersion: parsed.data.promptVersion,
    },
  );
  return {
    available: true,
    label: "Draft for assessor verification",
    ...parsed.data,
  };
}
export const BenchmarkCommand = z
  .object({
    taskRef: AssessmentRef,
    action: z.enum(["CANDIDATE", "APPROVE"]),
    benchmarkRef: AssessmentRef.optional(),
    reviewAt: z.string().datetime(),
    declaration: z.string().min(10),
    context: z.string().min(1),
  })
  .strict();
export async function manageBenchmark(raw) {
  const input = BenchmarkCommand.parse(raw);
  return run("hr.assessment_benchmark.approve", async (tx, env) => {
    const row = await tx.assessmentTaskVersion.findFirst({
      where: { tenantId: env.tenantId, id: input.taskRef, status: "PUBLISHED" },
    });
    if (!row || !row.definition.benchmarkPolicy)
      fail(
        "BENCHMARK_POLICY_MISSING",
        "Publish a task with an approved timing policy first",
      );
    if (row.ownerCode !== env.who.employeeCode)
      fail(
        "OWNER_REQUIRED",
        "Only the task owner may approve a benchmark",
        403,
      );
    const t = row.definition,
      bp = t.benchmarkPolicy,
      cfg = await config(tx, env.tenantId);
    const scope = `${scopeKey(t)}|${input.context}`;
    let result;
    if (input.action === "CANDIDATE") {
      const samples = await tx.assessmentTimingSample.findMany({
        where: {
          tenantId: env.tenantId,
          taskCode: t.taskCode,
          taskVersion: t.taskVersion,
          unit: bp.unit,
          clockBasis: bp.clockBasis,
          complexity: t.complexity,
          technology: t.technology,
          context: input.context,
          capturedAt: {
            gte: new Date(
              env.now.getTime() - days(t.evidencePolicy.freshnessDays),
            ),
          },
        },
      });
      const candidate = benchmarkCandidate(
        samples,
        cfg.policy,
        bp.plausibilityFloorMinutes,
      );
      if (!candidate)
        fail(
          "INSUFFICIENT_SAMPLES",
          "Benchmark requires at least 12 comparable samples from 4 employees",
        );
      const prior = await tx.assessmentBenchmark.findFirst({
        where: {
          tenantId: env.tenantId,
          taskCode: t.taskCode,
          taskVersion: t.taskVersion,
          scopeKey: scope,
        },
        orderBy: { version: "desc" },
      });
      result = await tx.assessmentBenchmark.create({
        data: {
          tenantId: env.tenantId,
          taskCode: t.taskCode,
          taskVersion: t.taskVersion,
          version: (prior?.version || 0) + 1,
          scopeKey: scope,
          unit: bp.unit,
          clockBasis: bp.clockBasis,
          complexity: t.complexity,
          technology: t.technology,
          context: input.context,
          minutesPerUnit: candidate.minutesPerUnit,
          provenance: json(candidate),
          ownerCode: env.who.employeeCode,
          reviewAt: new Date(input.reviewAt),
        },
      });
    } else {
      const candidate = await tx.assessmentBenchmark.findFirst({
        where: {
          tenantId: env.tenantId,
          id: input.benchmarkRef,
          taskCode: t.taskCode,
          taskVersion: t.taskVersion,
          status: "CANDIDATE",
          scopeKey: scope,
        },
      });
      if (!candidate) fail("NOT_FOUND", "Candidate benchmark not found", 404);
      const samples = await tx.assessmentTimingSample.findMany({
        where: {
          tenantId: env.tenantId,
          id: { in: candidate.provenance.sampleRefs },
          withdrawnAt: null,
          accepted: true,
          comparable: true,
        },
      });
      if (!benchmarkCandidate(samples, cfg.policy, bp.plausibilityFloorMinutes))
        fail(
          "EVIDENCE_CHANGED",
          "Candidate evidence changed; regenerate the proposal",
        );
      await tx.assessmentBenchmark.updateMany({
        where: {
          tenantId: env.tenantId,
          taskCode: t.taskCode,
          taskVersion: t.taskVersion,
          scopeKey: scope,
          status: "APPROVED",
        },
        data: { status: "SUPERSEDED" },
      });
      result = await tx.assessmentBenchmark.update({
        where: { id: candidate.id },
        data: {
          status: "APPROVED",
          approvedByCode: env.who.employeeCode,
          effectiveFrom: env.now,
        },
      });
    }
    await audit(tx, env, `BENCHMARK_${input.action}`, result.id, input, result);
    await event(
      tx,
      env,
      input.action === "APPROVE"
        ? "hr.benchmark.approved.v1"
        : "hr.benchmark.candidate.v1",
      result.id,
      { taskCode: t.taskCode, benchmarkRef: result.id },
    );
    return json(result);
  });
}
