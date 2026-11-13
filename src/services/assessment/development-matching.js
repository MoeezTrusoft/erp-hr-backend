import { WorkOpportunityEvent } from "@trusoft/contracts/assessment-pm";
import {
  eligibility,
  scheduleMinutes,
} from "@trusoft/contracts/assessment-rules";
import {
  config,
  identity,
  currentProfile,
  hash,
  json,
  fail,
  days,
} from "./base.js";
import { planningSnapshotFor } from "./planning.js";
import { qualifiedCandidates } from "./workflow.js";

export async function storeWorkOpportunity(tx, env, raw) {
  const value = WorkOpportunityEvent.parse(raw),
    cfg = await config(tx, env.tenantId);
  if (
    value.companyUuid !== env.tenantId ||
    !cfg.sourceRegister?.some((s) => s.source === value.source && s.enabled)
  )
    fail(
      "SOURCE_SCOPE",
      "Opportunity must belong to a registered company source",
      403,
    );
  await identity(tx, env.tenantId, value.ownerCode);
  const key = `${value.source}:${value.sourceRecordId}`;
  const where = {
    tenantId_kind_key: {
      tenantId: env.tenantId,
      kind: "WORK_OPPORTUNITY",
      key,
    },
  };
  const old = await tx.assessmentIntegration.findUnique({ where });
  if (old?.sequence > value.sourceVersion) return { ignored: "OLDER_VERSION" };
  if (old?.sequence === value.sourceVersion) {
    if (hash(old.payload) !== hash(value))
      fail(
        "IDEMPOTENCY_CONFLICT",
        "Opportunity revision changed without a new version",
      );
    return { duplicate: true };
  }
  const data = {
    employeeCode: value.ownerCode,
    sourceRef: value.sourceRecordId,
    sequence: value.sourceVersion,
    status: value.state,
    payload: json(value),
  };
  const row = await tx.assessmentIntegration.upsert({
    where,
    create: { tenantId: env.tenantId, kind: "WORK_OPPORTUNITY", key, ...data },
    update: data,
  });
  return { opportunityRef: row.id, state: row.status };
}

function intersect(a, b, site) {
  return a
    .filter((i) => !site || i.site === site)
    .flatMap((x) =>
      b
        .filter((i) => !site || i.site === site)
        .map((y) => ({
          start: new Date(
            Math.max(Date.parse(x.start), Date.parse(y.start)),
          ).toISOString(),
          end: new Date(
            Math.min(Date.parse(x.end), Date.parse(y.end)),
          ).toISOString(),
        }))
        .filter((i) => i.end > i.start),
    );
}
export function matchPracticeCandidate({
  action,
  opportunity,
  person,
  supervisor,
  now,
}) {
  const p = opportunity.payload;
  if (
    opportunity.status !== "AVAILABLE" ||
    Date.parse(p.validUntil) <= +now ||
    Date.parse(p.occurredAt) > +now + 5000 ||
    p.risk !== "LOW" ||
    !p.requirements.every((r) => r.supervisedAllowed)
  )
    return null;
  if (
    !p.requirements.some(
      (r) =>
        r.taskCode === action.payload.taskCode &&
        r.taskVersion === action.payload.taskVersion,
    )
  )
    return null;
  if (
    !person?.active ||
    !supervisor?.active ||
    person.employeeCode === supervisor.employeeCode ||
    person.calendarIssues.length ||
    supervisor.calendarIssues.length
  )
    return null;
  if (
    !eligibility({
      requirements: p.requirements,
      capabilities: person.capabilities,
      restrictions: person.restrictions,
      prerequisites: person.prerequisites,
      supervised: true,
      now,
    }).eligible ||
    !eligibility({
      requirements: p.requirements,
      capabilities: supervisor.capabilities,
      restrictions: supervisor.restrictions,
      prerequisites: supervisor.prerequisites,
      now,
    }).eligible
  )
    return null;
  const schedule = scheduleMinutes({
    minutes: p.minutes,
    intervals: intersect(person.intervals, supervisor.intervals, p.site),
    earliest: new Date(Math.max(+now, Date.parse(p.from))).toISOString(),
    latest: p.to,
  });
  if (
    !schedule.feasible ||
    !eligibility({
      requirements: p.requirements,
      capabilities: supervisor.capabilities,
      restrictions: supervisor.restrictions,
      prerequisites: supervisor.prerequisites,
      now: new Date(schedule.finish),
    }).eligible ||
    !eligibility({
      requirements: p.requirements,
      capabilities: person.capabilities,
      restrictions: person.restrictions,
      prerequisites: person.prerequisites,
      supervised: true,
      now: new Date(schedule.finish),
    }).eligible
  )
    return null;
  return {
    opportunityRef: opportunity.id,
    source: p.source,
    sourceRecordId: p.sourceRecordId,
    sourceVersion: p.sourceVersion,
    supervisorCode: supervisor.employeeCode,
    raterCode: supervisor.employeeCode,
    from: p.from,
    to: p.to,
    minutes: p.minutes,
    earliestFinish: schedule.finish,
    validUntil: p.validUntil,
    nonroutine: p.nonroutine,
    requiresPlannerRecheck: true,
    reason:
      "Current scoped capability and a shared HR calendar window; PM must recheck all allocations, dependencies and tools before booking.",
  };
}

export async function matchDevelopmentOpportunities(tx, env) {
  const cfg = await config(tx, env.tenantId);
  if (
    !["HR_INTEGRATION", "PM_SHADOW", "CONTROLLED", "AUTOMATIC"].includes(
      cfg.policy.stage,
    )
  )
    return;
  const runKey = `development-match:${Math.floor(+env.now / 15000)}`;
  if (
    await tx.assessmentAutomationRun.findUnique({
      where: { tenantId_runKey: { tenantId: env.tenantId, runKey } },
    })
  )
    return;
  const prior = await tx.assessmentAutomationRun.findFirst({
    where: { tenantId: env.tenantId, kind: "DEVELOPMENT_MATCH" },
    orderBy: { createdAt: "desc" },
  });
  const rows = await tx.assessmentIntegration.findMany({
    where: {
      tenantId: env.tenantId,
      kind: "DEVELOPMENT",
      status: { in: ["PROPOSED", "APPROVED"] },
      ...(prior?.actions.cursor ? { id: { gt: prior.actions.cursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: 20,
  });
  const opportunities = await tx.assessmentIntegration.findMany({
    where: {
      tenantId: env.tenantId,
      kind: "WORK_OPPORTUNITY",
      status: "AVAILABLE",
    },
  });
  const cache = new Map(),
    outcomes = [];
  const personSnapshot = async (employeeCode, from, to) => {
    const key = `${employeeCode}:${from}:${to}`;
    if (!cache.has(key)) {
      try {
        cache.set(
          key,
          (
            await planningSnapshotFor(tx, env, {
              employeeCodes: [employeeCode],
              from,
              to,
            })
          ).employees[0],
        );
      } catch (error) {
        if (
          ![
            "IDENTITY_UNVERIFIED",
            "IDENTITY_INACTIVE",
            "IDENTITY_SCOPE_CHANGED",
            "PROFILE_SCOPE_CHANGED",
          ].includes(error.code)
        )
          throw error;
        cache.set(key, null);
      }
    }
    return cache.get(key);
  };
  for (const row of rows) {
    const choices = [],
      reasons = [];
    let employee, profile;
    try {
      employee = await identity(tx, env.tenantId, row.employeeCode);
      profile = await currentProfile(tx, env, employee);
    } catch (error) {
      if (
        ![
          "IDENTITY_UNVERIFIED",
          "IDENTITY_INACTIVE",
          "IDENTITY_SCOPE_CHANGED",
          "PROFILE_SCOPE_CHANGED",
        ].includes(error.code)
      )
        throw error;
      reasons.push(error.code);
    }
    const requirement = profile?.definition.requirements.find(
      (r) =>
        r.taskCode === row.payload.taskCode &&
        r.taskVersion === row.payload.taskVersion,
    );
    const task =
      requirement &&
      (await tx.assessmentTaskVersion.findFirst({
        where: {
          tenantId: env.tenantId,
          taskCode: requirement.taskCode,
          taskVersion: requirement.taskVersion,
          status: "PUBLISHED",
        },
      }));
    if (!task) reasons.push("CURRENT_PROFILE_SCOPE_REQUIRED");
    else {
      const matches = opportunities
        .filter(
          (o) =>
            Date.parse(o.payload.validUntil) > +env.now &&
            Date.parse(o.payload.to) > +env.now &&
            o.payload.requirements.some(
              (r) =>
                r.taskCode === requirement.taskCode &&
                r.taskVersion === requirement.taskVersion,
            ),
        )
        .sort((a, b) => a.payload.to.localeCompare(b.payload.to))
        .slice(0, 5);
      const raters = await qualifiedCandidates(
        tx,
        env,
        employee,
        [task.familyCode],
        {
          dueAt: new Date(+env.now + days(21)).toISOString(),
          policy: cfg.policy,
          minutes: cfg.policy.raterTaskMinutes,
        },
      );
      const eligibleRaters = raters
        .filter(
          (r) =>
            r.active &&
            !r.onLeave &&
            r.employeeCode !== employee.employeeCode &&
            r.managerCode !== employee.employeeCode &&
            r.openCount < cfg.policy.raterMaxOpen &&
            r.qualifications.some(
              (q) =>
                q.familyCode === task.familyCode &&
                q.expiresAt > env.now &&
                q.calibration.passed &&
                !q.flags.includes("DISQUALIFIED") &&
                (q.scopes.includes(task.definition.scope) ||
                  q.scopes.includes("*")),
            ),
        )
        .sort((a, b) => a.openCount - b.openCount)
        .slice(0, 3);
      for (const o of matches) {
        const from = new Date(Math.max(+env.now, Date.parse(o.payload.from)))
            .toISOString()
            .slice(0, 10),
          to = o.payload.to.slice(0, 10);
        const person = await personSnapshot(row.employeeCode, from, to);
        for (const r of eligibleRaters) {
          const match = matchPracticeCandidate({
            action: row,
            opportunity: o,
            person,
            supervisor: await personSnapshot(r.employeeCode, from, to),
            now: env.now,
          });
          if (
            match &&
            r.qualifications.some(
              (q) =>
                q.familyCode === task.familyCode &&
                q.expiresAt > new Date(match.earliestFinish) &&
                q.calibration.passed &&
                !q.flags.includes("DISQUALIFIED") &&
                (q.scopes.includes(task.definition.scope) ||
                  q.scopes.includes("*")),
            )
          )
            choices.push(match);
        }
      }
      if (!choices.length) reasons.push("NO_ELIGIBLE_SHARED_WORK_WINDOW");
    }
    const suggestions = choices
      .sort((a, b) => a.earliestFinish.localeCompare(b.earliestFinish))
      .slice(0, 5);
    const matching = {
      suggestions,
      reasons,
      alternative: suggestions.length
        ? null
        : "Arrange a controlled practical case or observation; missing opportunity does not change ratings.",
      requiresManagerApproval: true,
    };
    if (hash(row.payload.practiceMatching || null) !== hash(matching))
      await tx.assessmentIntegration.update({
        where: { id: row.id },
        data: {
          sequence: { increment: 1 },
          payload: json({
            ...row.payload,
            practiceMatching: matching,
            matchedAt: env.now,
          }),
        },
      });
    outcomes.push({
      developmentRef: row.id,
      choices: suggestions.length,
      reasons,
    });
  }
  await tx.assessmentAutomationRun.create({
    data: {
      tenantId: env.tenantId,
      runKey,
      kind: "DEVELOPMENT_MATCH",
      policyVersion: cfg.version,
      inputDigest: hash({
        rows: rows.map((r) => [r.id, r.sequence]),
        opportunities: opportunities.map((o) => [o.id, o.sequence]),
      }),
      inputs: {
        developmentRefs: rows.map((r) => r.id),
        opportunityRefs: opportunities.map((o) => o.id),
      },
      actions: { outcomes, cursor: rows.length === 20 ? rows.at(-1).id : null },
      outcome: "PROPOSED",
    },
  });
}
