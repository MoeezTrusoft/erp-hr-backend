import {
  benchmarkCandidate,
  benchmarkDrift,
  median,
} from "@trusoft/contracts/assessment-rules";
import {
  config,
  audit,
  event,
  exception,
  hash,
  json,
  days,
  scopeKey,
} from "./base.js";
import { proposeJobDescription } from "./downstream.js";
import { maintainRaterMetrics } from "./rater-metrics.js";

// Each maintenance result is immutable and reproducible from its captured inputs.
export async function maintainAssessment(tx, env) {
  const cfg = await config(tx, env.tenantId);
  const runKey = `maintenance:${env.now.toISOString().slice(0, 13)}`;
  if (
    await tx.assessmentAutomationRun.findUnique({
      where: { tenantId_runKey: { tenantId: env.tenantId, runKey } },
    })
  )
    return;
  const actions = [],
    inputs = { sources: [], benchmarkSamples: [], profileCycles: [] };
  actions.push({
    kind: "RATER_METRICS",
    groups: await maintainRaterMetrics(tx, env, cfg),
  });
  // Calibration flags describe process anomalies; they neither recommend nor change scores.
  if (cfg.policy.consistencyTolerance != null) {
    const observations = await tx.assessmentObservation.findMany({
      where: {
        tenantId: env.tenantId,
        observedAt: { gte: new Date(env.now - days(90)) },
      },
      select: { assessorCode: true, draftedNote: true, assessmentRef: true },
    });
    for (const code of new Set(observations.map((o) => o.assessorCode))) {
      const drafted = observations.filter(
        (o) => o.assessorCode === code && o.draftedNote?.version,
      );
      if (drafted.length < 10) continue;
      const rate =
        drafted.filter((o) => o.draftedNote.kept && !o.draftedNote.edited)
          .length / drafted.length;
      if (rate <= cfg.policy.consistencyTolerance) continue;
      const key = `rater:${code}:UNCHANGED_DRAFT_RATE`;
      await exception(tx, env, key, "RATER_CONSISTENCY", code, {
        metric: "UNCHANGED_DRAFT_RATE",
        samples: drafted.length,
        rate,
        tolerance: cfg.policy.consistencyTolerance,
      });
      const qualifications = await tx.assessmentQualification.findMany({
        where: { tenantId: env.tenantId, employeeCode: code },
      });
      for (const q of qualifications)
        await tx.assessmentQualification.update({
          where: { id: q.id },
          data: {
            flags: [...new Set([...(q.flags || []), "UNCHANGED_DRAFT_RATE"])],
            version: { increment: 1 },
          },
        });
      const owners = [
        ...new Set((cfg.departments || []).map((d) => d.ownerCode)),
      ];
      for (const employeeCode of owners)
        await tx.assessmentNotification.upsert({
          where: {
            tenantId_key: {
              tenantId: env.tenantId,
              key: `${key}:${employeeCode}:${env.now.toISOString().slice(0, 7)}`,
            },
          },
          create: {
            tenantId: env.tenantId,
            employeeCode,
            key: `${key}:${employeeCode}:${env.now.toISOString().slice(0, 7)}`,
            kind: "RATER_CONSISTENCY",
            dueAt: env.now,
            payload: { raterCode: code, exceptionKey: key },
          },
          update: {},
        });
      actions.push({ kind: "RATER_CONSISTENCY", raterCode: code });
    }
  }
  const notices = await tx.assessmentNotification.findMany({
    where: {
      tenantId: env.tenantId,
      sentAt: null,
      dueAt: { lte: env.now },
      kind: { not: "DAILY_DIGEST" },
    },
    take: 2000,
  });
  const localDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.policy.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(env.now);
  for (const employeeCode of new Set(notices.map((n) => n.employeeCode))) {
    const key = `digest:${localDay}:${employeeCode}`;
    if (
      await tx.assessmentNotification.findUnique({
        where: { tenantId_key: { tenantId: env.tenantId, key } },
      })
    )
      continue;
    const group = notices.filter((n) => n.employeeCode === employeeCode);
    const digest = await tx.assessmentNotification.create({
      data: {
        tenantId: env.tenantId,
        employeeCode,
        key,
        kind: "DAILY_DIGEST",
        dueAt: env.now,
        sentAt: env.now,
        payload: {
          date: localDay,
          items: group.map((n) => ({
            kind: n.kind,
            assessmentRef: n.assessmentRef,
            ...n.payload,
          })),
        },
      },
    });
    await tx.assessmentNotification.updateMany({
      where: { tenantId: env.tenantId, id: { in: group.map((n) => n.id) } },
      data: { sentAt: env.now },
    });
    actions.push({ kind: "DAILY_DIGEST", ref: digest.id });
  }
  for (const source of cfg.sourceRegister || []) {
    if (!source.enabled) continue;
    const circuit = await tx.assessmentException.findUnique({
      where: {
        tenantId_key: {
          tenantId: env.tenantId,
          key: `source:${source.source}`,
        },
      },
    });
    const since = circuit?.detail?.recovery?.at
      ? new Date(
          Math.max(+new Date(circuit.detail.recovery.at), +env.now - days(30)),
        )
      : new Date(env.now - days(30));
    const recent = await tx.assessmentEvidence.findMany({
      where: {
        tenantId: env.tenantId,
        source: source.source,
        captureAt: { gte: since },
      },
      select: { id: true, integrityFlags: true },
    });
    const bad = recent.filter((e) => e.integrityFlags.length).length;
    const backlog = await tx.assessmentInboxEvent.findFirst({
      where: {
        tenantId: env.tenantId,
        source: source.source,
        status: { in: ["PENDING", "DEAD_LETTER"] },
      },
      orderBy: { createdAt: "asc" },
    });
    inputs.sources.push({
      source: source.source,
      count: recent.length,
      flagged: bad,
      oldestPending: backlog?.createdAt || null,
    });
    if (
      recent.length >= 10 &&
      bad / recent.length > cfg.policy.sourceIntegrityRate
    ) {
      await exception(
        tx,
        env,
        `source:${source.source}`,
        "CIRCUIT_BREAKER",
        source.source,
        { reason: "INTEGRITY_RATE", flagged: bad, total: recent.length },
        "SOURCE_OWNER",
      );
      actions.push({ kind: "SOURCE_PAUSED", source: source.source });
    }
    if (backlog && env.now - backlog.createdAt > source.maxLagMinutes * 60000)
      await exception(
        tx,
        env,
        `source-lag:${source.source}`,
        "SOURCE_LAG",
        source.source,
        {
          oldestPending: backlog.createdAt,
          maxLagMinutes: source.maxLagMinutes,
        },
        "SOURCE_OWNER",
      );
  }
  const tasks = await tx.assessmentTaskVersion.findMany({
    where: { tenantId: env.tenantId, status: "PUBLISHED" },
  });
  for (const row of tasks) {
    const task = row.definition,
      bp = task.benchmarkPolicy;
    if (!bp) continue;
    const samples = await tx.assessmentTimingSample.findMany({
      where: {
        tenantId: env.tenantId,
        taskCode: task.taskCode,
        taskVersion: task.taskVersion,
        unit: bp.unit,
        clockBasis: bp.clockBasis,
        complexity: task.complexity,
        technology: task.technology,
        capturedAt: {
          gte: new Date(env.now - days(task.evidencePolicy.freshnessDays)),
        },
        accepted: true,
        comparable: true,
        withdrawnAt: null,
      },
    });
    for (const context of new Set(samples.map((s) => s.context))) {
      const group = samples.filter((s) => s.context === context),
        candidate = benchmarkCandidate(
          group,
          cfg.policy,
          bp.plausibilityFloorMinutes,
        );
      if (!candidate) continue;
      const scope = `${scopeKey(task)}|${context}`;
      const prior = await tx.assessmentBenchmark.findMany({
        where: {
          tenantId: env.tenantId,
          taskCode: task.taskCode,
          taskVersion: task.taskVersion,
          scopeKey: scope,
        },
        orderBy: { version: "desc" },
      });
      if (prior.some((b) => b.status === "CANDIDATE")) continue;
      const approved = prior.find((b) => b.status === "APPROVED");
      const periods = [
        ...new Set(group.map((s) => s.capturedAt.toISOString().slice(0, 7))),
      ]
        .sort()
        .filter((p) => p < env.now.toISOString().slice(0, 7))
        .slice(-3);
      const trend = periods.map((period) => {
        const p = group.filter((s) =>
          s.capturedAt.toISOString().startsWith(period),
        );
        return {
          period,
          count: p.length,
          median: median(
            p.map(
              (s) => Number(s.attributableMinutes) / Number(s.acceptedUnits),
            ),
          ),
        };
      });
      const drift =
        approved &&
        benchmarkDrift(
          trend.map((p) => p.median),
          Number(approved.minutesPerUnit),
          cfg.policy.driftTolerance,
          cfg.policy.driftPeriods,
        );
      if (approved && !drift) continue;
      const b = await tx.assessmentBenchmark.create({
        data: {
          tenantId: env.tenantId,
          taskCode: task.taskCode,
          taskVersion: task.taskVersion,
          scopeKey: scope,
          version: (prior[0]?.version || 0) + 1,
          unit: bp.unit,
          clockBasis: bp.clockBasis,
          complexity: task.complexity,
          technology: task.technology,
          context,
          minutesPerUnit: candidate.minutesPerUnit,
          ownerCode: row.ownerCode,
          reviewAt: new Date(env.now.getTime() + days(90)),
          provenance: json({
            ...candidate,
            trend,
            priorBenchmarkRef: approved?.id || null,
            drift: !!drift,
            prospectiveOnly: true,
          }),
        },
      });
      inputs.benchmarkSamples.push({
        benchmarkRef: b.id,
        sampleRefs: candidate.sampleRefs,
      });
      actions.push({ kind: "BENCHMARK_CANDIDATE", ref: b.id });
      await event(tx, env, "hr.benchmark.candidate.v1", b.id, {
        taskCode: task.taskCode,
        benchmarkRef: b.id,
      });
      if (drift)
        await exception(
          tx,
          env,
          `benchmark:${b.id}`,
          "BENCHMARK_DRIFT",
          b.id,
          { trend, prior: approved.minutesPerUnit, proposed: b.minutesPerUnit },
          "BENCHMARK_OWNER",
        );
    }
  }
  if (
    ["HR_INTEGRATION", "PM_SHADOW", "CONTROLLED", "AUTOMATIC"].includes(
      cfg.policy.stage,
    )
  ) {
    const profiles = await tx.assessmentProfileVersion.findMany({
      where: { tenantId: env.tenantId, status: "PUBLISHED" },
    });
    for (const profile of profiles) {
      const bindings = await tx.employeeAssessmentProfile.findMany({
        where: {
          tenantId: env.tenantId,
          profileRef: profile.id,
          effectiveUntil: null,
        },
      });
      if (!bindings.length) continue;
      const rows = await tx.assessmentAppraisalInput.findMany({
        where: {
          tenantId: env.tenantId,
          employeeCode: { in: bindings.map((b) => b.employeeCode) },
          amendment: false,
        },
        orderBy: { createdAt: "desc" },
      });
      const cycles = [...new Set(rows.map((r) => r.cycleId))].slice(
        0,
        cfg.policy.jdCycles,
      );
      const rates = cycles.map((cycle) => {
        const people = new Map();
        for (const r of rows.filter((r) => r.cycleId === cycle))
          if (!people.has(r.employeeCode)) people.set(r.employeeCode, r);
        let gaps = 0;
        for (const r of people.values())
          if (
            profile.definition.requirements.some((req) =>
              r.content.tasks?.some(
                (t) =>
                  t.taskCode === req.taskCode &&
                  t.taskVersion === req.taskVersion &&
                  t.dimensions.some(
                    (d) =>
                      d.status === "RATED" &&
                      req[
                        { K: "requiredK", S: "requiredS", V: "targetV" }[
                          d.dimension
                        ]
                      ] != null &&
                      d.score <
                        req[
                          { K: "requiredK", S: "requiredS", V: "targetV" }[
                            d.dimension
                          ]
                        ],
                  ),
              ),
            )
          )
            gaps++;
        return {
          cycle,
          total: people.size,
          rate: people.size ? gaps / people.size : 0,
        };
      });
      inputs.profileCycles.push({ profileRef: profile.id, rates });
      if (
        rates.length >= cfg.policy.jdCycles &&
        rates.every((r) => r.rate > cfg.policy.jdGapRate)
      ) {
        const proposal = await proposeJobDescription(
          tx,
          env,
          profile,
          bindings[0].employeeCode,
          `Observed role gaps exceed ${cfg.policy.jdGapRate * 100}% across ${rates.length} cycles. Owner review required; no requirements changed automatically.`,
        );
        actions.push({ kind: "JD_PROPOSAL", ref: proposal.id });
      }
    }
  }
  await tx.assessmentAutomationRun.create({
    data: {
      tenantId: env.tenantId,
      runKey,
      policyVersion: cfg.version || 1,
      kind: "MAINTENANCE",
      inputDigest: hash(inputs),
      inputs: json(inputs),
      actions: json(actions),
      outcome: "COMPLETED",
    },
  });
  await audit(tx, env, "MAINTENANCE", env.tenantId, inputs, actions);
}
