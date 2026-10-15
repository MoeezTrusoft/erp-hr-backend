import { exception, json } from "./base.js";

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return n
    ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2
    : null;
};

export function summarizeRaters(revisions, evidence, limits) {
  const caseByEvidence = new Map(evidence.map((e) => [e.id, e.caseRef]));
  const observations = new Map();
  // A later published revision replaces the earlier revision for monitoring only.
  // Both signed revisions remain unchanged in the record.
  for (const r of [...revisions].sort((a, b) => a.sequence - b.sequence))
    for (const o of r.snapshot.observations)
      observations.set(`${r.assessmentRef}:${o.taskCode}`, {
        revision: r,
        observation: o,
      });
  const groups = new Map(),
    shared = new Map();
  for (const { revision, observation: o } of observations.values()) {
    const task = revision.snapshot.profile.tasks.find(
      (t) => t.taskCode === o.taskCode,
    );
    const groupKey = `${o.assessorCode}:${task.familyCode}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        employeeCode: o.assessorCode,
        familyCode: task.familyCode,
        taskCount: 0,
        durations: [],
        drafted: 0,
        unchangedDrafts: 0,
        dimensions: Object.fromEntries(
          ["K", "S", "V"].map((d) => [
            d,
            {
              observed: 0,
              pending: 0,
              na: 0,
              distribution: [0, 0, 0, 0, 0],
              naReasons: {},
              sharedComparisons: 0,
              sharedMatches: 0,
            },
          ]),
        ),
      };
      groups.set(groupKey, group);
    }
    group.taskCount++;
    if (o.durationSeconds != null) group.durations.push(o.durationSeconds);
    if (o.draftedNote?.version) {
      group.drafted++;
      if (o.draftedNote.kept && !o.draftedNote.edited) group.unchangedDrafts++;
    }
    for (const d of o.dimensions) {
      const target = group.dimensions[d.dimension];
      if (d.status === "RATED") {
        target.observed++;
        target.distribution[d.score]++;
      } else if (d.status === "PENDING") target.pending++;
      else {
        target.na++;
        target.naReasons[d.reasonCode || "UNSPECIFIED"] =
          (target.naReasons[d.reasonCode || "UNSPECIFIED"] || 0) + 1;
      }
      if (d.status !== "RATED") continue;
      const cases = new Set(
        revision.snapshot.links
          .filter((l) => l.taskCode === o.taskCode && l.state === "CONFIRMED")
          .map((l) => caseByEvidence.get(l.evidenceRef))
          .filter(Boolean),
      );
      for (const caseRef of cases) {
        const key = `${caseRef}:${o.taskCode}:${o.taskVersion}:${d.dimension}`;
        if (!shared.has(key)) shared.set(key, []);
        shared.get(key).push({ groupKey, score: d.score });
      }
    }
  }
  for (const [key, ratings] of shared) {
    const dimension = key.split(":").at(-1),
      unique = [...new Map(ratings.map((r) => [r.groupKey, r])).values()];
    for (let i = 0; i < unique.length; i++)
      for (let j = i + 1; j < unique.length; j++)
        for (const rating of [unique[i], unique[j]]) {
          const d = groups.get(rating.groupKey).dimensions[dimension];
          d.sharedComparisons++;
          if (unique[i].score === unique[j].score) d.sharedMatches++;
        }
  }
  return [...groups.values()].map(({ durations, ...g }) => {
    const flags = [],
      medianTaskSeconds = median(durations);
    for (const [dimension, d] of Object.entries(g.dimensions)) {
      d.level4Share = d.observed ? d.distribution[4] / d.observed : null;
      d.naShare = g.taskCount ? d.na / g.taskCount : null;
      d.sharedCaseAgreement = d.sharedComparisons
        ? d.sharedMatches / d.sharedComparisons
        : null;
      if (
        d.observed >= limits.minimumSamples &&
        limits.level4ShareMax != null &&
        d.level4Share > limits.level4ShareMax
      )
        flags.push(`${dimension}_LEVEL4_SHARE`);
      if (
        g.taskCount >= limits.minimumSamples &&
        limits.naShareMax != null &&
        d.naShare > limits.naShareMax
      )
        flags.push(`${dimension}_NA_SHARE`);
      if (
        d.sharedComparisons >= limits.minimumSamples &&
        limits.sharedCaseAgreementMin != null &&
        d.sharedCaseAgreement < limits.sharedCaseAgreementMin
      )
        flags.push(`${dimension}_SHARED_CASE_AGREEMENT`);
    }
    if (
      durations.length >= limits.minimumSamples &&
      limits.medianTaskSecondsMin != null &&
      medianTaskSeconds < limits.medianTaskSecondsMin
    )
      flags.push("TASK_CARD_DURATION");
    return {
      ...g,
      medianTaskSeconds,
      durationSampleCount: durations.length,
      durationBasis: "DECLARED_ACTIVE_FORM_SECONDS",
      unchangedDraftShare: g.drafted ? g.unchangedDrafts / g.drafted : null,
      flags,
    };
  });
}

export async function maintainRaterMetrics(tx, env, cfg) {
  const revisions = await tx.assessmentRevision.findMany({
    where: {
      tenantId: env.tenantId,
      state: "PUBLISHED",
      publishedAt: { gte: new Date(+env.now - 90 * 86400000) },
    },
  });
  const evidence = await tx.assessmentEvidence.findMany({
    where: {
      tenantId: env.tenantId,
      id: {
        in: [
          ...new Set(
            revisions.flatMap((r) =>
              r.snapshot.links.map((l) => l.evidenceRef),
            ),
          ),
        ],
      },
    },
    select: { id: true, caseRef: true },
  });
  const metrics = summarizeRaters(
    revisions,
    evidence,
    cfg.policy.consistencyLimits,
  );
  for (const metric of metrics) {
    const key = `${metric.employeeCode}:${metric.familyCode}:${env.now.toISOString().slice(0, 7)}`;
    const calibrations = await tx.assessmentIntegration.findMany({
      where: {
        tenantId: env.tenantId,
        employeeCode: metric.employeeCode,
        kind: "CALIBRATION_ATTEMPT",
        createdAt: { gte: new Date(+env.now - 90 * 86400000) },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const payload = json({
      ...metric,
      asOf: env.now,
      periodDays: 90,
      policyVersion: cfg.version,
      referenceAgreement: calibrations
        .filter((r) => r.payload.familyCode === metric.familyCode)
        .map((r) => ({
          attemptRef: r.id,
          agreement: r.payload.agreement,
          status: r.status,
        })),
      interpretation:
        "Process calibration indicators; never employee scores or rater targets.",
    });
    await tx.assessmentIntegration.upsert({
      where: {
        tenantId_kind_key: {
          tenantId: env.tenantId,
          kind: "RATER_METRICS",
          key,
        },
      },
      create: {
        tenantId: env.tenantId,
        employeeCode: metric.employeeCode,
        kind: "RATER_METRICS",
        key,
        sourceRef: key,
        status: metric.flags.length ? "REVIEW_REQUIRED" : "MONITORED",
        payload,
      },
      update: {
        payload,
        status: metric.flags.length ? "REVIEW_REQUIRED" : "MONITORED",
        sequence: { increment: 1 },
      },
    });
    if (!metric.flags.length) continue;
    await exception(
      tx,
      env,
      `rater-metrics:${key}`,
      "RATER_CONSISTENCY",
      metric.employeeCode,
      payload,
      "HR_PROCESS_OWNER",
    );
    const qualifications = await tx.assessmentQualification.findMany({
      where: {
        tenantId: env.tenantId,
        employeeCode: metric.employeeCode,
        familyCode: metric.familyCode,
      },
    });
    for (const q of qualifications)
      await tx.assessmentQualification.update({
        where: { id: q.id },
        data: {
          flags: [...new Set([...q.flags, ...metric.flags])],
          version: { increment: 1 },
        },
      });
    for (const employeeCode of new Set(
      (cfg.departments || []).map((d) => d.ownerCode),
    )) {
      const noticeKey = `rater-metrics:${key}:${employeeCode}`;
      await tx.assessmentNotification.upsert({
        where: { tenantId_key: { tenantId: env.tenantId, key: noticeKey } },
        create: {
          tenantId: env.tenantId,
          employeeCode,
          key: noticeKey,
          kind: "RATER_CONSISTENCY",
          dueAt: env.now,
          payload: {
            raterCode: metric.employeeCode,
            familyCode: metric.familyCode,
            flags: metric.flags,
          },
        },
        update: {},
      });
    }
  }
  return metrics.length;
}
