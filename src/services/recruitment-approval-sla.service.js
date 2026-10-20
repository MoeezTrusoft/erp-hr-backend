// src/services/recruitment-approval-sla.service.js — F-02.
//
// Approval SLA reminders and escalation for REQUISITION and OFFER requests in
// the HR Approval Centre. The Approval Centre itself is untouched: this module
// only READS HrApprovalRequest / HrApprovalAudit and WRITES outbox events the
// Notification Hub maps (internal notifications travel as events — the
// notification client can only email candidates).
//
// TIME IN STAGE. HrApprovalRequest has no due/SLA column (and this finding adds
// no migration). Every Approval Centre transition writes one HrApprovalAudit row
// in the same transaction as the stage move, so the latest audit row's createdAt
// is the moment the request entered its current stage; a request with no audit
// row falls back to its own createdAt.
//
// THRESHOLDS. At >= 1x the stage's SLA a reminder is enqueued
// (hr.recruitment.approval_reminder.v1); at >= 2x an escalation
// (hr.recruitment.approval_escalated.v1). They address different audiences (the
// stage owner vs the role above it), so a request first seen past 2x gets both.
//
// IDEMPOTENCY WITHOUT A MIGRATION. The outbox row IS the record that a reminder
// was sent: its aggregateId is the deterministic key
//   `${requestId}:${version}:${stage}:reminder|escalation`
// and a key that already has an OutboxEvent with the same eventName is skipped.
// The Approval Centre bumps `version` on every transition, so a request that
// moves (or is returned and resubmitted into the same stage) gets a fresh clock
// and a fresh key. Each enqueue runs in its own tenantTransaction holding a
// transaction-scoped advisory lock on the key, so two overlapping runs cannot
// both pass the existence check. Limitation: the outbox retention sweep deletes
// PUBLISHED rows after 30 days, so a request stuck in ONE stage for longer than
// that is reminded again at most once per retention window.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { recruitmentApprovalReminderEvent, recruitmentApprovalEscalatedEvent } from "./hrEvents.js";

const slaLog = logger.child({ component: "recruitment-approval-sla" });

/** The Approval Centre kinds this SLA covers. */
export const APPROVAL_SLA_KINDS = Object.freeze(["REQUISITION", "OFFER"]);

/**
 * Stages in which a request waits on an APPROVER. INITIATOR is excluded on
 * purpose (a draft, or a request returned to its initiator, waits on the
 * requester, not on an approval), as are the terminal stages.
 */
export const APPROVAL_SLA_STAGES = Object.freeze(["LINE_MANAGER", "HR", "MANAGEMENT"]);

/** Terminal Approval Centre stages (src/services/approval/service.js actionsFor). */
export const APPROVAL_TERMINAL_STAGES = Object.freeze(["APPROVED", "REJECTED", "WITHDRAWN"]);

export const DEFAULT_APPROVAL_SLA_HOURS = 48;

export const APPROVAL_REMINDER_EVENT = "hr.recruitment.approval_reminder.v1";
export const APPROVAL_ESCALATED_EVENT = "hr.recruitment.approval_escalated.v1";

const LEVELS = Object.freeze([
    { level: "reminder", multiple: 1, eventName: APPROVAL_REMINDER_EVENT, build: recruitmentApprovalReminderEvent },
    { level: "escalation", multiple: 2, eventName: APPROVAL_ESCALATED_EVENT, build: recruitmentApprovalEscalatedEvent },
]);

const HOUR_MS = 60 * 60 * 1000;

const positiveHours = (value) => {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * SLA hours per stage, read at call time.
 *
 *   HR_RECRUITMENT_APPROVAL_SLA_HOURS        base SLA in hours (default 48)
 *   HR_RECRUITMENT_APPROVAL_SLA_STAGE_HOURS  optional JSON per-stage override,
 *                                            e.g. {"LINE_MANAGER":24,"MANAGEMENT":72}
 *
 * Invalid values (non-numeric, <= 0, malformed JSON, unknown stages) are ignored
 * and fall back to the base, the same tolerant posture as
 * HR_RECRUITMENT_STAGE_SLA_DAYS: a typo must not stop the sweep.
 */
export function approvalSlaConfig(env = process.env) {
    const baseHours = positiveHours(env.HR_RECRUITMENT_APPROVAL_SLA_HOURS) ?? DEFAULT_APPROVAL_SLA_HOURS;
    const perStage = {};
    const raw = env.HR_RECRUITMENT_APPROVAL_SLA_STAGE_HOURS;
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const stage of APPROVAL_SLA_STAGES) {
                    const hours = positiveHours(parsed[stage]);
                    if (hours) perStage[stage] = hours;
                }
            }
        } catch {
            slaLog.warn("approval SLA: HR_RECRUITMENT_APPROVAL_SLA_STAGE_HOURS is not valid JSON — using the base SLA");
        }
    }
    return { baseHours, perStage, hoursFor: (stage) => perStage[stage] ?? baseHours };
}

/** The deterministic outbox aggregateId for one (request, version, stage, level). */
export const approvalSlaKey = (request, level) => `${request.id}:${request.version}:${request.stage}:${level}`;

/**
 * Sweep ONE tenant's pending REQUISITION/OFFER approvals and enqueue the due
 * reminders/escalations. Returns a bounded summary.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {Date} [args.now]
 * @param {string} [args.correlationId]  the job's correlation id (LOG-3)
 * @param {number} [args.limit=500]       max pending requests per tenant per run
 */
export async function sweepApprovalSla({ tenantId, now = new Date(), correlationId, limit = 500, env = process.env } = {}) {
    const summary = { scanned: 0, reminded: 0, escalated: 0, deduped: 0, stale: 0, dropped: 0 };
    if (!tenantId) return summary;

    const at = new Date(now);
    const config = approvalSlaConfig(env);

    const requests = await prisma.hrApprovalRequest.findMany({
        where: { tenantId, kind: { in: [...APPROVAL_SLA_KINDS] }, stage: { in: [...APPROVAL_SLA_STAGES] } },
        select: {
            id: true,
            tenantId: true,
            kind: true,
            sourceRef: true,
            stage: true,
            version: true,
            round: true,
            employeeCode: true,
            managerCode: true,
            createdAt: true,
        },
        orderBy: { id: "asc" },
        take: limit,
    });
    // Defence in depth: the where clause already scopes tenant/kind/stage.
    const pending = requests.filter(
        (r) => r.tenantId === tenantId && APPROVAL_SLA_KINDS.includes(r.kind) && APPROVAL_SLA_STAGES.includes(r.stage),
    );
    summary.scanned = pending.length;
    if (!pending.length) return summary;

    // Latest audit row per request = when it entered its current stage.
    const audits = await prisma.hrApprovalAudit.findMany({
        where: { tenantId, approvalRef: { in: pending.map((r) => r.id) } },
        select: { approvalRef: true, createdAt: true },
        orderBy: { createdAt: "desc" },
    });
    const enteredAt = new Map();
    for (const audit of audits) {
        const ts = new Date(audit.createdAt);
        const prior = enteredAt.get(audit.approvalRef);
        if (!prior || ts > prior) enteredAt.set(audit.approvalRef, ts);
    }

    for (const request of pending) {
        const stageEnteredAt = enteredAt.get(request.id) ?? new Date(request.createdAt);
        const hours = (at.getTime() - stageEnteredAt.getTime()) / HOUR_MS;
        const slaHours = config.hoursFor(request.stage);

        for (const { level, multiple, eventName, build } of LEVELS) {
            if (hours < slaHours * multiple) continue;
            const key = approvalSlaKey(request, level);
            const outcome = await tenantTransaction(
                prisma,
                async (tx) => {
                    // Serialize on the key so overlapping runs cannot both enqueue.
                    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:approval-sla:${key}`}, 0))`;
                    const prior = await tx.outboxEvent.findFirst({
                        where: { tenantId, eventName, aggregateId: key },
                        select: { id: true },
                    });
                    if (prior) return "deduped";
                    // The request may have moved since the scan; its new version
                    // gets its own clock on the next run.
                    const current = await tx.hrApprovalRequest.findFirst({
                        where: { tenantId, id: request.id },
                        select: { stage: true, version: true },
                    });
                    if (!current || current.stage !== request.stage || current.version !== request.version) return "stale";
                    const row = await enqueueHrDomainEvent(
                        tx,
                        build(request, { correlationId }, {
                            aggregateId: key,
                            stageEnteredAt,
                            hoursInStage: Math.round(hours * 10) / 10,
                            slaHours,
                        }),
                    );
                    return row ? "enqueued" : "dropped";
                },
                { tenantId },
            );
            if (outcome === "enqueued") summary[level === "reminder" ? "reminded" : "escalated"] += 1;
            else if (outcome === "deduped") summary.deduped += 1;
            else if (outcome === "stale") summary.stale += 1;
            else summary.dropped += 1;
        }
    }

    slaLog.info({ tenantId, ...summary }, "approval SLA sweep: tenant done");
    return summary;
}
