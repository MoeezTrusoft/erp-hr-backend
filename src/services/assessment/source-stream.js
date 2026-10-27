import Redis from "ioredis";
import { EventEnvelope } from "@trusoft/contracts/envelopes";
import { WorkEvidenceEvent } from "@trusoft/contracts/assessment";
import { PmAssessmentEventPayloads } from "@trusoft/contracts/assessment-pm";
import prisma from "../../lib/prisma.js";
import { mcpCtx } from "../../lib/requestContext.js";
import { tenantTransaction } from "../../lib/rlsTenant.js";
import { config, hash, fail, json } from "./base.js";
import logger from "../../lib/logger.js";

// Only the authenticated private event fabric is consumed here. Public clients use
// evidence_ingest, which checks the registered service principal and tenant claim.
export async function acceptPmActual(raw) {
  const e = EventEnvelope.parse(raw);
  if (
    ![
      "pm.assessment.actual_recorded.v1",
      "pm.employee.code_reconciled.v1",
      "pm.assessment.opportunity.v1",
    ].includes(e.name)
  )
    return { ignored: true };
  if (e.actor.type !== "service" || e.actor.id !== "pm-assessment-outbox")
    fail("SOURCE_IDENTITY", "Unexpected PM event producer", 403);
  const p = PmAssessmentEventPayloads[e.name].parse(e.payload);
  if (e.name === "pm.assessment.opportunity.v1") {
    if (p.companyUuid !== e.tenantId)
      fail("SOURCE_SCOPE", "Opportunity company mismatch", 403);
    return mcpCtx.run({ user: { tenantId: e.tenantId } }, () =>
      tenantTransaction(
        prisma,
        async (tx) => {
          const cfg = await config(tx, e.tenantId);
          if (
            !cfg.sourceRegister?.some(
              (s) =>
                s.source === "PM" &&
                s.enabled &&
                s.servicePrincipal === e.actor.id,
            ) ||
            p.source !== "PM"
          )
            fail(
              "SOURCE_UNAPPROVED",
              "Register the PM source before matching work",
            );
          const old = await tx.assessmentInboxEvent.findUnique({
            where: {
              tenantId_eventId: { tenantId: e.tenantId, eventId: p.eventId },
            },
          });
          if (old && hash(old.payload) !== hash(p))
            fail("IDEMPOTENCY_CONFLICT", "Opportunity content changed");
          if (!old)
            await tx.assessmentInboxEvent.create({
              data: {
                tenantId: e.tenantId,
                eventId: p.eventId,
                source: "PM",
                payload: json(p),
              },
            });
          return { queued: !old, duplicate: !!old };
        },
        { tenantId: e.tenantId, txOptions: { isolationLevel: "Serializable" } },
      ),
    );
  }
  if (e.name === "pm.employee.code_reconciled.v1")
    return mcpCtx.run({ user: { tenantId: e.tenantId } }, () =>
      tenantTransaction(
        prisma,
        async (tx) => {
          const change = await tx.assessmentCodeChange.findFirst({
            where: {
              tenantId: e.tenantId,
              id: p.changeRef,
              oldCode: p.oldCode,
              newCode: p.newCode,
            },
          });
          if (!change)
            fail(
              "CODE_CHANGE_MISMATCH",
              "Code reconciliation does not match an approved correction",
            );
          await tx.assessmentCodeChange.update({
            where: { id: change.id },
            data: { propagationState: "RECONCILED" },
          });
          return { reconciled: true };
        },
        { tenantId: e.tenantId },
      ),
    );
  const timingEnd = p.finishedAt,
    timingStart = p.startedAt;
  const event = WorkEvidenceEvent.parse({
    eventId: e.id,
    companyUuid: e.tenantId,
    source: "PM",
    sourceRecordId: p.reservationRef,
    sourceVersion: p.sourceVersion,
    occurredAt: p.finishedAt,
    workType: p.workType,
    action: "ACCEPTED",
    contributors: [
      {
        employeeCode: p.employeeCode,
        role: "EXECUTOR",
        individualEffortMinutes: p.attributableMinutes,
      },
    ],
    qualityStatus: p.qualityStatus,
    sourceRef: p.sourceRef,
    contentHash: p.sourceHash,
    classification: "INTERNAL",
    acceptanceVerified: ["ACCEPTED", "REWORK_ACCEPTED"].includes(
      p.qualityStatus,
    ),
    executionVerified: true,
    substantive: false,
    nonroutine: false,
    taskCodes: p.taskCodes,
    timing: {
      start: timingStart,
      end: timingEnd,
      timezone: "UTC",
      clockBasis: "PERSON_EFFORT",
      individualEffortMinutes: p.attributableMinutes,
      acceptedUnits: p.acceptedUnits,
      unit: p.unit,
      complexity: p.complexity,
      technology: p.technology,
      context: p.context,
      waits: [],
      workingIntervals: [],
      attempts: 1,
      reworkMinutes: 0,
      reworkIncluded: true,
    },
  });
  return mcpCtx.run({ user: { tenantId: e.tenantId } }, () =>
    tenantTransaction(
      prisma,
      async (tx) => {
        const cfg = await config(tx, e.tenantId),
          source = cfg.sourceRegister?.find(
            (s) =>
              s.source === "PM" &&
              s.enabled &&
              s.servicePrincipal === e.actor.id,
          );
        if (!source)
          fail(
            "SOURCE_UNAPPROVED",
            "Register the PM evidence source before harvesting",
          );
        const old = await tx.assessmentInboxEvent.findUnique({
          where: { tenantId_eventId: { tenantId: e.tenantId, eventId: e.id } },
        });
        if (old) {
          if (hash(old.payload) !== hash(event))
            fail("IDEMPOTENCY_CONFLICT", "Event content changed");
          return { duplicate: true };
        }
        await tx.assessmentInboxEvent.create({
          data: {
            tenantId: e.tenantId,
            eventId: e.id,
            source: "PM",
            payload: json(event),
          },
        });
        return { queued: true };
      },
      { tenantId: e.tenantId, txOptions: { isolationLevel: "Serializable" } },
    ),
  );
}

export function startAssessmentSourceBridge() {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.HR_ASSESSMENT_WORKER_ENABLED !== "true" ||
    !process.env.REDIS_URL
  )
    return { stop: async () => {} };
  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => logger.warn("Assessment source stream unavailable"));
  const group = "hr-assessment-pm-v21",
    consumer = `hr-${process.pid}`;
  let stopped = false,
    timer,
    running,
    ready = false;
  const processRow = async ([id, fields]) => {
    const data = Object.fromEntries(
      Array.from({ length: fields.length / 2 }, (_, i) => [
        fields[2 * i],
        fields[2 * i + 1],
      ]),
    );
    try {
      await acceptPmActual(JSON.parse(data.envelope));
      await redis.xack("pm:events", group, id);
      await redis.hdel("hr:assessment:pm:retry", id);
    } catch (error) {
      const attempts = await redis.hincrby("hr:assessment:pm:retry", id, 1);
      if (attempts >= 5) {
        await redis.xadd(
          "hr:assessment:pm:dead-letter",
          "*",
          "sourceId",
          id,
          "code",
          error.code || "INVALID_EVENT",
          "envelope",
          data.envelope || "{}",
        );
        await redis.xack("pm:events", group, id);
      }
      logger.warn(
        { code: error.code || "SOURCE_RETRY" },
        "Assessment PM source retry",
      );
    }
  };
  const tick = async () => {
    if (stopped) return;
    try {
      if (!ready) {
        if (redis.status === "wait") await redis.connect();
        try {
          await redis.xgroup("CREATE", "pm:events", group, "0", "MKSTREAM");
        } catch (e) {
          if (!e.message.includes("BUSYGROUP")) throw e;
        }
        ready = true;
      }
      const claimed = await redis.xautoclaim(
        "pm:events",
        group,
        consumer,
        30000,
        "0-0",
        "COUNT",
        30,
      );
      for (const row of claimed?.[1] || []) await processRow(row);
      const streams = await redis.xreadgroup(
        "GROUP",
        group,
        consumer,
        "COUNT",
        30,
        "BLOCK",
        1000,
        "STREAMS",
        "pm:events",
        ">",
      );
      for (const stream of streams || [])
        for (const row of stream[1]) await processRow(row);
    } catch {
      ready = false;
      logger.warn("Assessment source stream will retry");
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          running = tick();
        }, 1000);
    }
  };
  running = tick();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
      redis.disconnect();
    },
  };
}
