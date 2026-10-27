import { runSourceExtractionSweep } from "./source-extract.js";
import {
  storeWorkOpportunity,
  matchDevelopmentOpportunities,
} from "./development-matching.js";
import prisma from "../../lib/prisma.js";
import { mcpCtx } from "../../lib/requestContext.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { startOutboxDispatchLoop } from "../../jobs/outbox.loop.js";
import {
  config,
  hash,
  json,
  days,
  exception,
  event,
  audit,
  verifyAssessmentScope,
} from "./base.js";
import { processEvidenceEvent } from "./evidence.js";
import { createAssignment, reassignAssessment } from "./workflow.js";
import { reconcileIdentities } from "./catalog.js";
import { maintainAssessment } from "./maintenance.js";
import { loadAttendanceRuntime } from "../../lib/attendanceRuntime.js";
import { dateRange } from "../../lib/attendanceDates.js";
import { startAssessmentSourceBridge } from "./source-stream.js";
import { equivalentCapabilities } from "./equivalence.js";
import { offerHarvestedOpportunities } from "./opportunities.js";

export async function reconcileCompany(tx, env) {
  const cfg = await config(tx, env.tenantId),
    policy = cfg.policy;
  const bucket = env.now.toISOString().slice(0, 13);
  if (
    !(await tx.assessmentAutomationRun.findFirst({
      where: { tenantId: env.tenantId, runKey: `identity:${bucket}` },
    }))
  ) {
    const result = await reconcileIdentities(tx, env);
    await tx.assessmentAutomationRun.create({
      data: {
        tenantId: env.tenantId,
        runKey: `identity:${bucket}`,
        policyVersion: cfg.version || 1,
        kind: "IDENTITY",
        inputDigest: hash(bucket),
        inputs: { bucket },
        actions: json(result),
        outcome:
          result.ratio >= policy.identityThreshold ? "HEALTHY" : "PAUSED",
      },
    });
    if (result.ratio >= policy.identityThreshold) {
      const e = await tx.assessmentException.findFirst({
        where: {
          tenantId: env.tenantId,
          key: "IDENTITY_QUALITY",
          status: "OPEN",
        },
      });
      if (e)
        await tx.assessmentException.update({
          where: { id: e.id },
          data:
            e.stableSince &&
            env.now - e.stableSince >= policy.stableMinutes * 60000
              ? { status: "RESOLVED", resolvedAt: env.now }
              : { stableSince: e.stableSince || env.now },
        });
    }
  }
  const expired = await tx.assessmentCapability.findMany({
    where: {
      tenantId: env.tenantId,
      status: "CURRENT",
      expiresAt: { lte: env.now },
    },
  });
  for (const c of expired) {
    await tx.assessmentCapability.update({
      where: { id: c.id },
      data: { status: "EXPIRED" },
    });
    await event(tx, env, "hr.capability.expired.v1", c.id, {
      employeeCode: c.employeeCode,
      taskCode: c.taskCode,
      dimension: c.dimension,
      revisionRef: c.revisionRef,
    });
  }
  const active = await tx.assessmentAssignment.findMany({
    where: {
      tenantId: env.tenantId,
      state: {
        notIn: ["PUBLISHED", "REVOKED", "SUPERSEDED", "CLOSED_INCOMPLETE"],
      },
    },
  });
  const calendarStart = new Date(
    Math.max(
      env.now - days(365),
      Math.min(...active.map((a) => +a.createdAt), +env.now),
    ),
  )
    .toISOString()
    .slice(0, 10);
  const calendarEnd = new Date(
    Math.max(...active.map((a) => +a.dueAt), +env.now),
  )
    .toISOString()
    .slice(0, 10);
  const runtime = active.length
    ? await loadAttendanceRuntime({
        tenantId: env.tenantId,
        from: calendarStart,
        to: calendarEnd,
        db: tx,
      })
    : null;
  const workingDays = (person, from, to) => {
    const sign = to >= from ? 1 : -1,
      lo = new Date(Math.max(Math.min(+from, +to), Date.parse(calendarStart))),
      hi = new Date(Math.max(+from, +to));
    return (
      sign *
      dateRange(
        lo.toISOString().slice(0, 10),
        hi.toISOString().slice(0, 10),
        750,
      )
        .slice(1)
        .filter(
          (d) => runtime.resolve(person.employeeRowId, d).working === true,
        ).length
    );
  };
  for (const a of active) {
    try {
      await verifyAssessmentScope(tx, env, a);
    } catch (error) {
      if (!error.status) throw error;
      await tx.assessmentAssignment.update({
        where: { id: a.id },
        data: { state: "CLOSED_INCOMPLETE", version: { increment: 1 } },
      });
      await exception(
        tx,
        env,
        `scope:${a.id}`,
        "EMPLOYMENT_SCOPE_CHANGE",
        a.id,
        { employeeCode: a.employeeCode, reason: error.code },
      );
      await audit(
        tx,
        env,
        "PROFILE_SCOPE_CLOSE",
        a.id,
        { reason: error.code },
        { state: "CLOSED_INCOMPLETE" },
      );
      continue;
    }
    const people = await tx.assessmentIdentity.findMany({
      where: {
        tenantId: env.tenantId,
        employeeCode: { in: [a.employeeCode, a.raterCode, a.reviewerCode] },
        active: true,
      },
    });
    if (!people.some((p) => p.employeeCode === a.employeeCode)) {
      await tx.assessmentAssignment.update({
        where: { id: a.id },
        data: { state: "CLOSED_INCOMPLETE", version: { increment: 1 } },
      });
      await audit(
        tx,
        env,
        "EMPLOYEE_INACTIVE_CLOSE",
        a.id,
        { employeeCode: a.employeeCode },
        { state: "CLOSED_INCOMPLETE" },
      );
      continue;
    }
    const actorRows = people.filter((p) =>
      [a.raterCode, a.reviewerCode].includes(p.employeeCode),
    );
    const leave = await tx.leaveRequest.findMany({
      where: {
        tenantId: env.tenantId,
        employeeId: { in: actorRows.map((p) => p.employeeRowId) },
        status: "APPROVED",
        startDate: { lte: env.now },
        endDate: { gte: env.now },
      },
    });
    if (people.length !== 3 || leave.length) {
      try {
        const replacement = await reassignAssessment(tx, env, a);
        await tx.assessmentAssignment.update({
          where: { id: a.id },
          data: { ...replacement, version: { increment: 1 }, notifiedAt: null },
        });
        await audit(
          tx,
          env,
          "AUTOMATIC_REASSIGNMENT",
          a.id,
          { raterCode: a.raterCode, reviewerCode: a.reviewerCode },
          replacement,
          { freshVerificationRequired: true },
        );
      } catch (e) {
        if (!e.status) throw e;
        await exception(
          tx,
          env,
          `assignment:${a.id}:identity`,
          "REASSIGNMENT_REQUIRED",
          a.id,
          { requiresFreshRaterVerification: true, code: e.code },
        );
      }
      continue;
    }
    if (a.holdUntil && a.holdUntil > env.now) continue;
    const responsible = people.find((p) => p.employeeCode === a.raterCode),
      day = workingDays(responsible, a.createdAt, env.now),
      late = workingDays(responsible, a.dueAt, env.now);
    const stageAge = workingDays(responsible, a.stageStartedAt, env.now);
    if (
      a.state === "ACKNOWLEDGMENT_DUE" &&
      stageAge >= policy.stageWorkingDays
    ) {
      const contacts = await tx.assessmentNotification.findMany({
        where: {
          tenantId: env.tenantId,
          assessmentRef: a.id,
          employeeCode: a.employeeCode,
        },
        select: { id: true, kind: true, dueAt: true, sentAt: true },
      });
      await exception(
        tx,
        env,
        `ack-overdue:${a.id}`,
        "ACKNOWLEDGMENT_OVERDUE",
        a.id,
        {
          employeeCode: a.employeeCode,
          revisionNo: a.revisionNo,
          stageStartedAt: a.stageStartedAt,
          contactHistory: contacts,
          requiresIndependentExceptionApproval: true,
        },
      );
    }
    const milestones = !a.notifiedAt
      ? ["ASSIGNED"]
      : [
          day >= 3 ? "READINESS" : null,
          day >= Math.floor(workingDays(responsible, a.createdAt, a.dueAt) / 2)
            ? "MIDPOINT"
            : null,
          late >= -5 ? "DUE_SOON" : null,
          ...policy.escalationDays
            .filter((d) => late >= d)
            .map((d) => `OVERDUE_${d}`),
          stageAge >= policy.stageWorkingDays
            ? `STAGE_${a.state}_${a.revisionNo}`
            : null,
        ].filter(Boolean);
    for (const kind of milestones)
      for (const employeeCode of [a.raterCode, a.reviewerCode]) {
        const p = people.find((p) => p.employeeCode === employeeCode);
        const leave = await tx.leaveRequest.findFirst({
          where: {
            tenantId: env.tenantId,
            employeeId: p.employeeRowId,
            status: "APPROVED",
            startDate: { lte: env.now },
            endDate: { gte: env.now },
          },
        });
        if (leave) continue;
        const key = `${a.id}:${employeeCode}:${kind}`;
        await tx.assessmentNotification.upsert({
          where: { tenantId_key: { tenantId: env.tenantId, key } },
          create: {
            tenantId: env.tenantId,
            employeeCode,
            key,
            kind,
            assessmentRef: a.id,
            dueAt: env.now,
            payload: {
              employeeCode: a.employeeCode,
              assessmentRef: a.id,
              dueAt: a.dueAt.toISOString(),
            },
          },
          update: {},
        });
      }
    if (!a.notifiedAt)
      await tx.assessmentAssignment.update({
        where: { id: a.id },
        data: { notifiedAt: env.now },
      });
  }
  if (
    ["FOUNDATION", "EVIDENCE_SHADOW"].includes(policy.stage) ||
    (await tx.assessmentException.findFirst({
      where: {
        tenantId: env.tenantId,
        kind: "CIRCUIT_BREAKER",
        status: "OPEN",
      },
    }))
  )
    return;
  const triggers = await tx.assessmentTriggerPolicy.findMany({
    where: { tenantId: env.tenantId, enabled: true },
  });
  const profiles = await tx.employeeAssessmentProfile.findMany({
    where: {
      tenantId: env.tenantId,
      effectiveFrom: { lte: env.now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: env.now } }],
    },
  });
  for (const membership of profiles) {
    const key = membership.employeeCode;
    const prior = await tx.assessmentIntegration.findUnique({
      where: {
        tenantId_kind_key: {
          tenantId: env.tenantId,
          kind: "ACTIVE_PROFILE",
          key,
        },
      },
    });
    if (prior?.sourceRef === membership.id) continue;
    await tx.assessmentIntegration.upsert({
      where: {
        tenantId_kind_key: {
          tenantId: env.tenantId,
          kind: "ACTIVE_PROFILE",
          key,
        },
      },
      create: {
        tenantId: env.tenantId,
        employeeCode: key,
        kind: "ACTIVE_PROFILE",
        key,
        sourceRef: membership.id,
        status: "ACTIVE",
        payload: {},
      },
      update: { sourceRef: membership.id, sequence: { increment: 1 } },
    });
    await event(
      tx,
      env,
      "hr.employee.assessment_scope_changed.v1",
      membership.id,
      {
        employeeCode: key,
        reason: "PROFILE_CHANGED",
        effectiveAt: membership.effectiveFrom,
      },
    );
  }
  await offerHarvestedOpportunities(
    tx,
    env,
    cfg,
    profiles,
    triggers.find((t) => t.triggerType === "OPPORTUNISTIC"),
  );
  for (const trigger of triggers) {
    let created = await tx.assessmentAssignment.count({
      where: {
        tenantId: env.tenantId,
        purpose: trigger.triggerType,
        createdAt: {
          gte: new Date(env.now.toISOString().slice(0, 10) + "T00:00:00Z"),
        },
        holdUntil: { not: null },
      },
    });
    for (const membership of profiles) {
      if (created >= trigger.policy.dailyCap) break;
      const profile = await tx.assessmentProfileVersion.findFirst({
        where: {
          tenantId: env.tenantId,
          id: membership.profileRef,
          status: "PUBLISHED",
        },
      });
      if (!profile) continue;
      if (
        trigger.scopeFilter.familyCodes?.length &&
        !profile.definition.requirements.length
      )
        continue;
      const caps = await equivalentCapabilities(
        tx,
        env.tenantId,
        await tx.assessmentCapability.findMany({
          where: {
            tenantId: env.tenantId,
            employeeCode: membership.employeeCode,
          },
        }),
      );
      let taskCodes = [];
      if (trigger.triggerType === "INITIAL")
        taskCodes = profile.definition.requirements
          .filter(
            (r) =>
              !caps.some(
                (c) =>
                  c.taskCode === r.taskCode &&
                  c.taskVersion === r.taskVersion &&
                  c.status === "CURRENT" &&
                  c.expiresAt > env.now,
              ),
          )
          .map((r) => r.taskCode);
      if (trigger.triggerType === "RENEWAL")
        taskCodes = [
          ...new Set(
            caps
              .filter(
                (c) =>
                  c.expiresAt <=
                  new Date(env.now.getTime() + days(policy.renewalLeadDays)),
              )
              .map((c) => c.taskCode),
          ),
        ];
      if (trigger.triggerType === "ROLE_CHANGE")
        taskCodes = profile.definition.requirements
          .filter((r) =>
            ["K", "S"].some(
              (d) =>
                r[d === "K" ? "requiredK" : "requiredS"] != null &&
                !caps.some(
                  (c) =>
                    c.taskCode === r.taskCode &&
                    c.taskVersion === r.taskVersion &&
                    c.dimension === d &&
                    c.status === "CURRENT" &&
                    c.expiresAt > env.now &&
                    c.score >= r[d === "K" ? "requiredK" : "requiredS"],
                ),
            ),
          )
          .map((r) => r.taskCode);
      if (trigger.triggerType === "DEVELOPMENT") {
        const development = await tx.assessmentIntegration.findMany({
          where: {
            tenantId: env.tenantId,
            employeeCode: membership.employeeCode,
            kind: "DEVELOPMENT",
            status: "APPROVED",
          },
        });
        const completed = await tx.trainingEnrollment.findMany({
          where: {
            tenantId: env.tenantId,
            id: {
              in: development
                .map((i) => i.payload.enrollmentRef)
                .filter(Number.isInteger),
            },
            status: "COMPLETED",
          },
          select: { id: true },
        });
        taskCodes = development
          .filter(
            (i) =>
              (i.payload.dueAt && Date.parse(i.payload.dueAt) <= +env.now) ||
              completed.some((e) => e.id === i.payload.enrollmentRef),
          )
          .map((i) => i.payload.taskCode);
      }
      const familyTasks = trigger.scopeFilter.familyCodes?.length
        ? await tx.assessmentTaskVersion.findMany({
            where: {
              tenantId: env.tenantId,
              familyCode: { in: trigger.scopeFilter.familyCodes },
            },
            select: { taskCode: true },
          })
        : null;
      taskCodes = [...new Set(taskCodes)].filter(
        (c) =>
          profile.definition.requirements.some((r) => r.taskCode === c) &&
          (!familyTasks || familyTasks.some((t) => t.taskCode === c)),
      );
      if (
        !taskCodes.length ||
        active.some(
          (a) =>
            a.employeeCode === membership.employeeCode &&
            a.taskCodes.some((c) => taskCodes.includes(c)),
        )
      )
        continue;
      const key = hash({
        membership: membership.id,
        type: trigger.triggerType,
        taskCodes,
        current: caps.map((c) => ({
          ref: c.revisionRef,
          dimension: c.dimension,
          task: c.taskCode,
        })),
      });
      if (
        await tx.assessmentAssignment.findFirst({
          where: { tenantId: env.tenantId, idempotencyKey: key },
        })
      )
        continue;
      try {
        let dueAt = new Date(env.now.getTime() + days(trigger.policy.dueDays));
        if (trigger.triggerType === "INITIAL") {
          const person = await tx.assessmentIdentity.findUnique({
            where: {
              tenantId_employeeCode: {
                tenantId: env.tenantId,
                employeeCode: membership.employeeCode,
              },
            },
          });
          const employment =
            person &&
            (await tx.employee.findFirst({
              where: { tenant_id: env.tenantId, id: person.employeeRowId },
              select: { probation_end_date: true },
            }));
          const target = Math.max(
            +membership.effectiveFrom + days(policy.initialDays),
            +(employment?.probation_end_date || 0),
          );
          if (target > +env.now) dueAt = new Date(target);
        }
        const assignment = await createAssignment(
          tx,
          env,
          {
            employeeCode: membership.employeeCode,
            profileRef: profile.id,
            purpose: trigger.triggerType,
            period: env.now.toISOString().slice(0, 7),
            taskCodes,
            dueAt: dueAt.toISOString(),
            idempotencyKey: key,
          },
          true,
        );
        active.push(assignment);
        created++;
        await tx.assessmentAutomationRun.create({
          data: {
            tenantId: env.tenantId,
            runKey: `trigger:${key}`,
            policyVersion: trigger.version,
            kind: trigger.triggerType,
            inputDigest: hash({ membership, taskCodes }),
            inputs: json({ membership, taskCodes }),
            actions: { assessmentRef: assignment.id },
            outcome: "ASSIGNED",
          },
        });
      } catch (e) {
        if (!e.status || e.status >= 500) throw e;
        await exception(
          tx,
          env,
          `trigger:${key}`,
          "TRIGGER_BLOCKED",
          membership.id,
          { code: e.code, message: e.message },
        );
      }
    }
  }
  const queued = await tx.assessmentIntegration.findMany({
    where: {
      tenantId: env.tenantId,
      kind: { in: ["CAMPAIGN_REQUEST", "OPPORTUNITY", "RESTORATION_REQUEST"] },
      status: "QUEUED",
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  for (const item of queued) {
    const purpose = {
      CAMPAIGN_REQUEST: "CAMPAIGN",
      OPPORTUNITY: "OPPORTUNISTIC",
      RESTORATION_REQUEST: "RESTORATION",
    }[item.kind];
    const trigger = triggers.find((t) => t.triggerType === purpose);
    if (!trigger) continue;
    const count = await tx.assessmentAssignment.count({
      where: {
        tenantId: env.tenantId,
        purpose,
        createdAt: {
          gte: new Date(env.now.toISOString().slice(0, 10) + "T00:00:00Z"),
        },
      },
    });
    if (count >= trigger.policy.dailyCap) continue;
    if (Date.parse(item.payload.dueAt) <= +env.now) {
      await tx.assessmentIntegration.update({
        where: { id: item.id },
        data: { status: "EXPIRED", sequence: { increment: 1 } },
      });
      continue;
    }
    try {
      const a = await createAssignment(
        tx,
        env,
        {
          employeeCode: item.employeeCode,
          profileRef: item.sourceRef,
          purpose,
          period: item.payload.period || env.now.toISOString().slice(0, 7),
          dueAt: item.payload.dueAt,
          ...(item.payload.raterCode
            ? {
                raterCode: item.payload.raterCode,
                selectionReason:
                  "The qualified rater accepted the offered practical observation.",
              }
            : {}),
          ...(item.payload.taskCodes
            ? { taskCodes: item.payload.taskCodes }
            : {}),
          idempotencyKey: `queue:${item.id}`,
        },
        true,
      );
      await tx.assessmentIntegration.update({
        where: { id: item.id },
        data: {
          status: "ASSIGNED",
          targetRef: a.id,
          sequence: { increment: 1 },
        },
      });
      await tx.assessmentAutomationRun.create({
        data: {
          tenantId: env.tenantId,
          runKey: `queue:${item.id}`,
          policyVersion: trigger.version,
          kind: purpose,
          inputDigest: hash(item.payload),
          inputs: item.payload,
          actions: { assessmentRef: a.id },
          outcome: "ASSIGNED",
        },
      });
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      await exception(tx, env, `queue:${item.id}`, "TRIGGER_BLOCKED", item.id, {
        code: e.code,
      });
    }
  }
}
export async function runAssessmentAutomation() {
  // Discover only configured companies; each mutation runs with a company-local RLS context.
  const companies = await mcpCtx.run(
    { system: true },
    async () =>
      await prisma.assessmentConfiguration.findMany({
        select: { tenantId: true },
      }),
  );
  for (const { tenantId } of companies) {
    const env = {
      tenantId,
      who: { principal: "assessment-worker", employeeCode: null },
      now: new Date(),
    };
    await mcpCtx.run({ user: { tenantId } }, async () => {
      const pending = await prisma.assessmentInboxEvent.findMany({
        where: { tenantId, status: "PENDING", nextAttemptAt: { lte: env.now } },
        take: 30,
        orderBy: { createdAt: "asc" },
      });
      for (const item of pending) {
        const paused = await prisma.assessmentException.findFirst({
          where: {
            tenantId,
            key: `source:${item.source}`,
            kind: "CIRCUIT_BREAKER",
            status: "OPEN",
          },
        });
        if (paused) continue;
        try {
          await tenantTransaction(
            prisma,
            async (tx) => {
              const claimed = await tx.assessmentInboxEvent.updateMany({
                where: {
                  tenantId,
                  id: item.id,
                  status: "PENDING",
                  attempts: item.attempts,
                },
                data: {
                  status: "PROCESSING",
                  leaseUntil: new Date(Date.now() + 60000),
                  attempts: { increment: 1 },
                },
              });
              if (!claimed.count) return;
              const result = item.payload.state
                ? await storeWorkOpportunity(tx, env, item.payload)
                : await processEvidenceEvent(tx, env, item.payload);
              await tx.assessmentInboxEvent.update({
                where: { id: item.id },
                data: {
                  status: "PROCESSED",
                  processedAt: new Date(),
                  leaseUntil: null,
                },
              });
              await tx.assessmentAutomationRun.create({
                data: {
                  tenantId,
                  runKey: `event:${item.eventId}`,
                  policyVersion: (await config(tx, tenantId)).version,
                  kind: "EVIDENCE",
                  inputDigest: hash(item.payload),
                  inputs: { eventId: item.eventId, source: item.source },
                  actions: result,
                  outcome: "PROCESSED",
                },
              });
            },
            {
              tenantId,
              txOptions: { isolationLevel: "Serializable", timeout: 30000 },
            },
          );
        } catch (error) {
          await tenantTransaction(
            prisma,
            async (tx) => {
              await tx.assessmentInboxEvent.updateMany({
                where: {
                  tenantId,
                  id: item.id,
                  status: "PENDING",
                  attempts: item.attempts,
                },
                data: {
                  attempts: { increment: 1 },
                  status: item.attempts >= 4 ? "DEAD_LETTER" : "PENDING",
                  nextAttemptAt: new Date(
                    Date.now() + Math.min(3600000, 2 ** item.attempts * 10000),
                  ),
                  lastErrorCode: error.code || "PROCESSING_FAILED",
                },
              });
              if (item.attempts >= 4)
                await exception(
                  tx,
                  env,
                  `event:${item.id}`,
                  "DEAD_LETTER",
                  item.id,
                  {
                    source: item.source,
                    code: error.code || "PROCESSING_FAILED",
                  },
                  "INTEGRATION_OWNER",
                );
            },
            { tenantId },
          );
        }
      }
      await tenantTransaction(prisma, (tx) => reconcileCompany(tx, env), {
        tenantId,
        txOptions: { isolationLevel: "Serializable", timeout: 60000 },
      });
      await tenantTransaction(prisma, (tx) => maintainAssessment(tx, env), {
        tenantId,
        txOptions: { isolationLevel: "Serializable", timeout: 60000 },
      });
    });
  }
}
export async function runDevelopmentMatchingSweep() {
  const companies = await mcpCtx.run(
    { system: true },
    async () =>
      await prisma.assessmentConfiguration.findMany({
        select: { tenantId: true },
      }),
  );
  const failures = [];
  for (const { tenantId } of companies) {
    try {
      await mcpCtx.run(
        { user: { tenantId } },
        async () =>
          await tenantTransaction(
            prisma,
            (tx) =>
              matchDevelopmentOpportunities(tx, {
                tenantId,
                now: new Date(),
                who: { principal: "assessment-worker", employeeCode: null },
              }),
            {
              tenantId,
              txOptions: { isolationLevel: "Serializable", timeout: 60000 },
            },
          ),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}
export function startAssessmentWorker() {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.HR_ASSESSMENT_WORKER_ENABLED !== "true"
  )
    return { stop: async () => {} };
  const bridge = startAssessmentSourceBridge();
  const worker = startOutboxDispatchLoop({
    run: runAssessmentAutomation,
    intervalMs: 15000,
    errorBackoffMs: 30000,
  });
  const extractor = startOutboxDispatchLoop({
    run: runSourceExtractionSweep,
    intervalMs: 60000,
    errorBackoffMs: 30000,
  });
  const matcher = startOutboxDispatchLoop({
    run: runDevelopmentMatchingSweep,
    intervalMs: 15000,
    errorBackoffMs: 30000,
  });
  return {
    stop: async () => {
      await Promise.all([worker.stop(), extractor.stop(), matcher.stop()]);
      await bridge.stop();
    },
  };
}
