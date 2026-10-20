// src/services/recruitment-alerts.service.js
//
// Recruitment Phase 5 (plan 6.10) — analytics threshold alerts for the
// recruiting lead.
//
// A tenant sets thresholds on four metrics (TenantRecruitmentSettings
// .alertThresholds { timeToFillDays, slaBreaches, offerDeclineRatePct,
// failedHandoffs }) and names who receives the alerts (alertRecipientId, an
// employee). runRecruitmentAlertsJob runs hourly: for each tenant with
// thresholds it measures each watched metric over the rolling 30-day window
// (src/lib/recruitment-alerts.util.js documents the window and the episode
// model), then opens, updates or resolves that metric's RecruitmentAlert.
// A NEW open alert announces hr.recruitment.analytics_alert_raised.v1 once, in
// the same transaction as the row, routed to the recipient: the configured
// alertRecipientId, else the tenant's recruiting lead when one can be found
// (an active employee titled as leading recruiting / talent acquisition),
// else (Phase 6) the HR role: recipientId null with notifyRole "HR" on the
// payload and the alert's details, the same HR-role path the referral bonus
// event uses, so an alert is never announced to nobody.
//
// The metric arithmetic is the canonical one (src/lib/recruitmentMetrics.js):
// time to fill per requisition, the offer outcome rates and the stage SLA the
// analytics payload reports, so an alert never disagrees with the dashboard.
//
// Thresholds are written through this service, not the settings tool: the
// upsert takes the settings row's advisory lock and checks the version the
// caller read, exactly like recruitment-settings.service.js, so a thresholds
// save and a settings save cannot overwrite each other.
import { Prisma } from "@prisma/client";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { scopedEmployeeWhere, withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
    ACTIVE_APPLICATION_STAGES,
    aggregateTimeToFill,
    NULL_REASONS,
    offerAcceptance,
    slaAging,
    timeInStageForApplication,
    timeToFillForRequisition,
} from "../lib/recruitmentMetrics.js";
import {
    ACTIVE_ALERT_STATUSES,
    ALERT_METRICS,
    ALERT_METRIC_THRESHOLD_KEYS,
    ALERT_PERIOD_DAYS,
    ALERT_STATUS,
    ALERT_STATUSES,
    alertWindow,
    isBreached,
    isRecruitingLeadTitle,
    mergeThresholds,
    normalizeAlertThresholdsInput,
    planAlertTransition,
    readStoredThresholds,
    watchedMetrics,
} from "../lib/recruitment-alerts.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { getStageSlaConfig } from "./recruitmentAnalytics.service.js";

const log = logger.child({ component: "recruitment-alerts" });

export const ANALYTICS_ALERT_RAISED_EVENT = "hr.recruitment.analytics_alert_raised.v1";

export const DEFAULT_ALERTS_JOB_LIMIT = 200;
const MAX_ALERTS_JOB_LIMIT = 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
// Evidence ids kept on an alert's details (enough to start a drill-down).
const MAX_DETAIL_IDS = 50;

const fail = (message, code, status = 400) => Object.assign(new Error(message), { status, code });

const round1 = (n) => Math.round(n * 10) / 10;
const toNumber = (v) => (v === null || v === undefined ? null : Number(String(v)));
const clamp = (limit, def, max) => {
    const n = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : def;
    return n <= 0 ? def : Math.min(n, max);
};

/** The analyticsAlerts flag gates every alert tool (503, client code HR-5031). */
export function assertAlertsEnabled() {
    if (!isRecruitmentFlagEnabled("analyticsAlerts")) {
        throw fail("Recruitment analytics alerts are disabled", "HR-RECRUITMENT-ANALYTICS-ALERTS-DISABLED", 503);
    }
}

const requireTenant = (tenantId) => {
    if (!tenantId) throw fail("Verified company is required", "HR-TENANT-REQUIRED", 403);
};

// ── Event ───────────────────────────────────────────────────────────────────

/** Who an alert goes to when no recipient is configured and no lead is found. */
export const ALERT_FALLBACK_ROLE = "HR";

/** ids and figures only; the recipient is a routing id. */
export function recruitmentAnalyticsAlertRaisedEvent(alert, ctx = {}, extra = {}) {
    if (!alert?.tenantId) return null;
    return {
        eventName: ANALYTICS_ALERT_RAISED_EVENT,
        tenantId: alert.tenantId,
        aggregateType: "RecruitmentAlert",
        aggregateId: alert.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            alertId: String(alert.id),
            metric: alert.metric,
            periodStart: new Date(alert.periodStart).toISOString(),
            value: toNumber(alert.value),
            threshold: toNumber(alert.threshold),
            recipientId: extra?.recipientId != null ? String(extra.recipientId) : null,
            // No person to route to: the Notification Hub sends it to the HR role.
            ...(extra?.recipientId == null ? { notifyRole: ALERT_FALLBACK_ROLE } : {}),
        },
    };
}

// ── Thresholds ──────────────────────────────────────────────────────────────

const presentThresholds = (tenantId, row) => ({
    tenantId,
    thresholds: readStoredThresholds(row?.alertThresholds),
    alertRecipientId: row?.alertRecipientId ?? null,
    version: row?.version ?? 0,
    periodDays: ALERT_PERIOD_DAYS,
    metrics: ALERT_METRIC_THRESHOLD_KEYS,
});

/** The tenant's alert thresholds and recipient (empty when never set). */
export async function getAlertThresholds({ tenantId } = {}) {
    requireTenant(tenantId);
    const row = await prisma.tenantRecruitmentSettings.findUnique({
        where: { tenantId },
        select: { alertThresholds: true, alertRecipientId: true, version: true },
    });
    return presentThresholds(tenantId, row);
}

async function assertRecipient(tx, tenantId, employeeId) {
    const n = Number(employeeId);
    if (!Number.isInteger(n) || n <= 0) {
        throw fail("alertRecipientId must be an employee id", "HR-RECRUITMENT-ALERTS-RECIPIENT-INVALID");
    }
    const employee = await tx.employee.findFirst({
        where: scopedEmployeeWhere(tenantId, { id: n }),
        select: { id: true, status: true, separatedAt: true },
    });
    const active = employee && !employee.separatedAt && (!employee.status || String(employee.status).toLowerCase() === "active");
    if (!active) throw fail("alertRecipientId is not an active employee of this company", "HR-RECRUITMENT-ALERTS-RECIPIENT-INVALID");
    return n;
}

/**
 * Change the thresholds (keys present are set, null clears one) and/or the
 * recipient (undefined keeps it, null clears it). expectedVersion is the
 * settings version the caller read; a stale one is a 409.
 */
export async function setAlertThresholds({ tenantId, actorId = null, expectedVersion, thresholds, alertRecipientId } = {}) {
    requireTenant(tenantId);
    if (expectedVersion === undefined || expectedVersion === null || !Number.isInteger(Number(expectedVersion))) {
        throw fail("expectedVersion is required", "HR-RECRUITMENT-ALERTS-INVALID");
    }
    const change = thresholds === undefined ? {} : normalizeAlertThresholdsInput(thresholds);

    const row = await tenantTransaction(prisma, async (tx) => {
        // The same lock recruitment-settings.service.js takes on this row.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:recruitment-settings`}))`;
        const latest = await tx.tenantRecruitmentSettings.findUnique({ where: { tenantId } });
        if (Number(expectedVersion) !== (latest?.version ?? 0)) {
            throw fail("Recruitment settings changed; refresh before saving", "HR-RECRUITMENT-SETTINGS-VERSION-CONFLICT", 409);
        }
        const merged = mergeThresholds(latest?.alertThresholds, change);
        const write = {
            alertThresholds: Object.keys(merged).length ? merged : Prisma.DbNull,
            updatedById: actorId ?? null,
        };
        if (alertRecipientId !== undefined) {
            write.alertRecipientId = alertRecipientId === null ? null : await assertRecipient(tx, tenantId, alertRecipientId);
        }
        return tx.tenantRecruitmentSettings.upsert({
            where: { tenantId },
            create: { tenantId, ...write, version: 1 },
            update: { ...write, version: { increment: 1 } },
        });
    }, { tenantId });

    log.info(
        { tenantId, version: row.version, keys: Object.keys(change), recipientChanged: alertRecipientId !== undefined },
        "recruitment alert thresholds updated",
    );
    return presentThresholds(tenantId, row);
}

// ── Alerts: list and acknowledge ───────────────────────────────────────────

const presentAlert = (row) => ({
    id: row.id,
    metric: row.metric,
    status: row.status,
    periodStart: row.periodStart,
    value: toNumber(row.value),
    threshold: toNumber(row.threshold),
    details: row.details ?? null,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    acknowledgedById: row.acknowledgedById ?? null,
    acknowledgedAt: row.acknowledgedAt ?? null,
    resolvedAt: row.resolvedAt ?? null,
});

export async function listRecruitmentAlerts({ tenantId, status, metric, limit } = {}) {
    requireTenant(tenantId);
    const where = withTenant(tenantId, {});
    if (status !== undefined && status !== null && status !== "") {
        const s = String(status).toUpperCase();
        if (!ALERT_STATUSES.includes(s)) throw fail(`status must be one of ${ALERT_STATUSES.join(", ")}`, "HR-RECRUITMENT-ALERTS-INVALID");
        where.status = s;
    }
    if (metric !== undefined && metric !== null && metric !== "") {
        const m = String(metric).toUpperCase();
        if (!ALERT_METRICS.includes(m)) throw fail(`metric must be one of ${ALERT_METRICS.join(", ")}`, "HR-RECRUITMENT-ALERTS-INVALID");
        where.metric = m;
    }
    const rows = await prisma.recruitmentAlert.findMany({
        where,
        orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
        take: clamp(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    });
    return { alerts: rows.map(presentAlert), count: rows.length };
}

/**
 * OPEN → ACKNOWLEDGED. Acknowledging an acknowledged alert returns it as is;
 * a resolved alert is past acknowledging (409).
 */
export async function acknowledgeRecruitmentAlert({ tenantId, alertId, actorId = null, now = new Date() } = {}) {
    requireTenant(tenantId);
    const id = Number(alertId);
    if (!Number.isInteger(id) || id <= 0) throw fail("alertId must be a positive integer", "HR-RECRUITMENT-ALERTS-INVALID");
    const row = await tenantTransaction(prisma, async (tx) => {
        const claim = await tx.recruitmentAlert.updateMany({
            where: withTenant(tenantId, { id, status: ALERT_STATUS.OPEN }),
            data: { status: ALERT_STATUS.ACKNOWLEDGED, acknowledgedById: actorId ?? null, acknowledgedAt: new Date(now) },
        });
        const current = await tx.recruitmentAlert.findFirst({ where: withTenant(tenantId, { id }) });
        if (!current) throw fail("Alert not found", "HR-RECRUITMENT-ALERT-NOT-FOUND", 404);
        if (Number(claim?.count ?? 0) === 0 && current.status === ALERT_STATUS.RESOLVED) {
            throw fail("Alert is already resolved", "HR-RECRUITMENT-ALERT-RESOLVED", 409);
        }
        return current;
    }, { tenantId });
    return presentAlert(row);
}

// ── Metric measurement (one tenant, one window) ─────────────────────────────

const capIds = (ids) => ids.slice(0, MAX_DETAIL_IDS);

async function measureTimeToFill(tenantId, { from, to }) {
    const requisitions = await prisma.jobRequisition.findMany({
        where: { tenantId, offers: { some: { status: "ACCEPTED", respondedAt: { gte: from, lte: to } } } },
        select: {
            id: true,
            openings: true,
            transitions: { select: { fromStatus: true, toStatus: true, createdAt: true } },
            offers: { where: { status: "ACCEPTED" }, select: { status: true, respondedAt: true } },
        },
    });
    const filled = requisitions
        .map((r) => ({ id: r.id, ...timeToFillForRequisition(r.transitions, r.offers, r.openings) }))
        .filter((r) => r.timeToFillDays !== null && r.overallFillAt >= from && r.overallFillAt <= to);
    const value = aggregateTimeToFill(filled).meanTimeToFillDays;
    return {
        value,
        details: {
            requisitionsFilled: filled.length,
            requisitionIds: capIds(filled.map((r) => r.id)),
            ...(value === null ? { reason: NULL_REASONS.NO_FILLS } : {}),
        },
    };
}

async function measureSlaBreaches(tenantId, { to }) {
    const slaByStage = getStageSlaConfig();
    if (!Object.keys(slaByStage).length) return { value: null, details: { reason: NULL_REASONS.SLA_NOT_CONFIGURED } };
    const applications = await prisma.application.findMany({
        where: { tenantId, stage: { in: [...ACTIVE_APPLICATION_STAGES] } },
        select: {
            id: true,
            stage: true,
            appliedAt: true,
            stageHistory: { select: { fromStage: true, toStage: true, createdAt: true } },
        },
    });
    const breached = [];
    for (const a of applications) {
        const current = timeInStageForApplication(a.stageHistory, a.stage, a.appliedAt, to).find((d) => d.isCurrent);
        const aging = current ? slaAging(current.stage, current.daysInStage, slaByStage) : null;
        if (aging?.breached) breached.push(a.id);
    }
    return {
        value: breached.length,
        details: { openApplications: applications.length, breached: breached.length, applicationIds: capIds(breached) },
    };
}

async function measureOfferDeclineRate(tenantId, { from, to }) {
    const offers = await prisma.offer.findMany({
        where: {
            tenantId,
            OR: [
                { status: { in: ["ACCEPTED", "DECLINED"] }, respondedAt: { gte: from, lte: to } },
                { status: "EXPIRED", expiredAt: { gte: from, lte: to } },
            ],
        },
        select: { id: true, status: true },
    });
    const rates = offerAcceptance(offers);
    return {
        value: rates.declineRatePct,
        details: {
            finalOutcomes: rates.finalOutcomes,
            accepted: rates.ACCEPTED,
            declined: rates.DECLINED,
            expired: rates.EXPIRED,
            ...(rates.declineRatePct === null ? { reason: NULL_REASONS.NO_FINAL_OFFERS } : {}),
        },
    };
}

async function measureFailedHandoffs(tenantId, { from, to }) {
    const failed = await prisma.offerHandoff.findMany({
        where: { tenantId, status: "FAILED", updated_at: { gte: from, lte: to } },
        select: { id: true },
        orderBy: { id: "asc" },
    });
    return { value: failed.length, details: { failed: failed.length, handoffIds: capIds(failed.map((h) => h.id)) } };
}

const MEASURES = Object.freeze({
    TIME_TO_FILL: measureTimeToFill,
    SLA_BREACHES: measureSlaBreaches,
    OFFER_DECLINE_RATE: measureOfferDeclineRate,
    FAILED_HANDOFFS: measureFailedHandoffs,
});

/** Measure one metric for one tenant over the window. */
export async function measureAlertMetric(tenantId, metric, window) {
    const measure = MEASURES[metric];
    if (!measure) throw fail(`Unknown alert metric ${metric}`, "HR-RECRUITMENT-ALERTS-INVALID");
    const out = await measure(tenantId, window);
    return { value: out.value === null ? null : round1(Number(out.value)), details: out.details };
}

/** The tenant's recruiting lead, when one can be found (lowest id wins). */
export async function findRecruitingLeadId(tenantId) {
    const employees = await prisma.employee.findMany({
        where: scopedEmployeeWhere(tenantId, {
            OR: [
                { job_title: { contains: "recruit", mode: "insensitive" } },
                { job_title: { contains: "talent acquisition", mode: "insensitive" } },
            ],
        }),
        select: { id: true, job_title: true, status: true, separatedAt: true },
        orderBy: { id: "asc" },
        take: 50,
    });
    const lead = employees.find(
        (e) => isRecruitingLeadTitle(e.job_title) && !e.separatedAt && (!e.status || String(e.status).toLowerCase() === "active"),
    );
    return lead?.id ?? null;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/** Apply one metric's evaluation under the tenant; returns the action taken. */
async function applyEvaluation({ tenantId, metric, value, threshold, details, window, recipientId, now }) {
    return tenantTransaction(prisma, async (tx) => {
        // One evaluation per (tenant, metric) at a time: two overlapping runs
        // cannot both create the episode or both announce it.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:recruitment-alert:${metric}`}))`;
        const active = await tx.recruitmentAlert.findFirst({
            where: withTenant(tenantId, { metric, status: { in: [...ACTIVE_ALERT_STATUSES] } }),
            orderBy: [{ firstSeenAt: "desc" }, { id: "desc" }],
        });
        const samePeriod = active
            ? null
            : await tx.recruitmentAlert.findFirst({ where: withTenant(tenantId, { metric, periodStart: window.periodStart }) });
        const plan = planAlertTransition({ active, samePeriod, value, threshold });
        const at = new Date(now);
        const routing = (id) => (id == null ? { recipientId: null, notifyRole: ALERT_FALLBACK_ROLE } : { recipientId: id });
        const stamped = { ...details, ...routing(recipientId ?? null) };

        let row = null;
        if (plan.action === "CREATE") {
            row = await tx.recruitmentAlert.create({
                data: {
                    tenantId,
                    metric,
                    status: ALERT_STATUS.OPEN,
                    periodStart: window.periodStart,
                    value,
                    threshold,
                    details: stamped,
                    firstSeenAt: at,
                    lastSeenAt: at,
                },
            });
        } else if (plan.action === "REOPEN") {
            row = await tx.recruitmentAlert.update({
                where: { id: samePeriod.id },
                data: {
                    status: ALERT_STATUS.OPEN,
                    value,
                    threshold,
                    details: stamped,
                    firstSeenAt: at,
                    lastSeenAt: at,
                    resolvedAt: null,
                    acknowledgedById: null,
                    acknowledgedAt: null,
                },
            });
        } else if (plan.action === "TOUCH") {
            row = await tx.recruitmentAlert.update({
                where: { id: active.id },
                // The episode keeps the recipient its announcement went to.
                data: { value, threshold, details: { ...details, ...routing(active.details?.recipientId ?? null) }, lastSeenAt: at },
            });
        } else if (plan.action === "RESOLVE") {
            // value keeps the last breaching figure; the figure it resolved at
            // goes on the details.
            row = await tx.recruitmentAlert.update({
                where: { id: active.id },
                data: { status: ALERT_STATUS.RESOLVED, resolvedAt: at, details: { ...(active.details ?? {}), resolvedValue: value } },
            });
        }
        if (plan.emit && row) {
            await enqueueHrDomainEvent(tx, recruitmentAnalyticsAlertRaisedEvent(row, { actorId: null }, { recipientId }));
        }
        return plan.action;
    }, { tenantId });
}

const ACTION_COUNTER = Object.freeze({ CREATE: "opened", REOPEN: "opened", TOUCH: "updated", RESOLVE: "resolved", NONE: "unchanged" });

/**
 * Evaluate one tenant's watched metrics (run under that tenant's context).
 * Per-metric error isolation: one metric failing leaves the others evaluated.
 */
export async function evaluateTenantAlerts({ tenantId, thresholds, alertRecipientId = null, now = new Date() }) {
    const summary = { evaluated: 0, opened: 0, updated: 0, resolved: 0, unchanged: 0, notMeasurable: 0, events: 0, errors: 0 };
    const window = alertWindow(now);
    let recipient;
    const resolveRecipient = async () => {
        if (recipient === undefined) recipient = alertRecipientId ?? (await findRecruitingLeadId(tenantId));
        return recipient;
    };
    for (const metric of watchedMetrics(thresholds)) {
        const threshold = thresholds[ALERT_METRIC_THRESHOLD_KEYS[metric]];
        try {
            const { value, details } = await measureAlertMetric(tenantId, metric, window);
            summary.evaluated += 1;
            if (value === null) summary.notMeasurable += 1;
            // The recipient is only looked up when a breach may need routing.
            const recipientId = isBreached(value, threshold) ? await resolveRecipient() : null;
            const action = await applyEvaluation({ tenantId, metric, value, threshold, details, window, recipientId, now });
            summary[ACTION_COUNTER[action]] += 1;
            if (action === "CREATE" || action === "REOPEN") summary.events += 1;
        } catch (err) {
            summary.errors += 1;
            log.error({ tenantId, metric, code: err?.code, errMessage: err?.message }, "recruitment alerts: metric failed");
        }
    }
    return summary;
}

/**
 * Hourly: every tenant with thresholds, cross-tenant scan under the system
 * context, per-tenant work under that tenant, per-tenant error isolation.
 *
 * @param {{ now?: Date, limit?: number }} [args] limit = tenants per run
 * @returns {Promise<object>} the summary, or { skipped: "FLAG_OFF" }
 */
export async function runRecruitmentAlertsJob({ now = new Date(), limit } = {}) {
    if (!isRecruitmentFlagEnabled("analyticsAlerts")) return { skipped: "FLAG_OFF" };
    const summary = {
        tenants: 0, evaluated: 0, opened: 0, updated: 0, resolved: 0, unchanged: 0, notMeasurable: 0, events: 0, errors: 0,
    };
    const tenants = await mcpCtx.run({ system: true }, async () =>
        await prisma.tenantRecruitmentSettings.findMany({
            where: { alertThresholds: { not: Prisma.AnyNull } },
            select: { tenantId: true, alertThresholds: true, alertRecipientId: true },
            orderBy: { tenantId: "asc" },
            take: clamp(limit, DEFAULT_ALERTS_JOB_LIMIT, MAX_ALERTS_JOB_LIMIT),
        }),
    );
    for (const row of tenants) {
        const thresholds = readStoredThresholds(row.alertThresholds);
        if (!row.tenantId || !watchedMetrics(thresholds).length) continue;
        summary.tenants += 1;
        try {
            const result = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () =>
                await evaluateTenantAlerts({ tenantId: row.tenantId, thresholds, alertRecipientId: row.alertRecipientId ?? null, now }),
            );
            for (const [key, n] of Object.entries(result)) summary[key] += n;
        } catch (err) {
            summary.errors += 1;
            log.error({ tenantId: row.tenantId, code: err?.code, errMessage: err?.message }, "recruitment alerts: tenant failed");
        }
    }
    if (summary.tenants) log.info(summary, "recruitment alerts: pass done");
    return summary;
}
