// src/services/retention-run.service.js
//
// Recruitment Phase 5 (plan 6.9) — retention runs per tenant, the dry-run
// report, and the data-policy owner's sign-off that switches apply on.
//
// "Privacy obligations run on a schedule, not on memory": the nightly
// candidate-retention job (reminderScheduler.runCandidateRetentionJob) calls
// runTenantRetention once per tenant with an active policy. Every call records
// a CandidateRetentionRun, whatever happened:
//
//   * DRY_RUN   what apply WOULD erase (counts, a capped id list, legal-hold
//               suspensions). It is the report: hr.recruitment.
//               retention_dry_run_report.v1 goes to the tenant's data-policy
//               owner (dataPolicyOwnerId) in the same transaction and the row
//               is stamped reportSentAt.
//   * APPLY     what was erased. Only when the env mode is apply AND the
//               retention flag is on AND the tenant's retentionApplyEnabled is
//               true (src/lib/retention-run.util.js decideTenantRunMode).
//               applyRetention re-checks the flag and the tenant switch on its
//               own, so the destructive path has two independent gates.
//   * FAILED    the error text, so a silent tenant is visible as a failure.
//
// Phase 7: a manual hr_candidate_retention_apply goes through the same
// recording path (runManualRetention), so the runs list shows it too; an
// APPLY it performed is signed off by the caller.
//
// The switch: the owner signs off a COMPLETED dry-run from the last 7 days
// (hr_candidate_retention_signoff); that stamps the run and turns
// retentionApplyEnabled on with its timestamps and the run id. The owner can
// switch it off at once (hr_candidate_retention_apply_disable). Both are
// audited (Log) and announced (hr.recruitment.retention_apply_changed.v1).
// While no owner is set an admin decides, and names the owner with
// hr_candidate_retention_owner_set.
//
// The settings writes share recruitment-settings.service.js's per-tenant
// advisory lock and version counter, so they serialise with the settings tool.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { recordRetentionRun } from "../lib/recruitmentOpsMetrics.js";
import { RECRUITMENT_SCOPE } from "../lib/recruitmentAccess.js";
import {
    RETENTION_RUN_MODE,
    RETENTION_RUN_STATUS,
    SIGNOFF_MAX_AGE_DAYS,
    buildRunRecord,
    canManageRetention,
    decideTenantRunMode,
    readRunCandidates,
    signoffRefusal,
} from "../lib/retention-run.util.js";
import { applyRetention } from "./candidatePrivacy.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { logAction } from "../utils/logs.js";

const log = logger.child({ component: "retention-runs" });

export const RETENTION_DRY_RUN_REPORT_EVENT = "hr.recruitment.retention_dry_run_report.v1";
export const RETENTION_APPLY_CHANGED_EVENT = "hr.recruitment.retention_apply_changed.v1";

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};
const idStr = (value) => (value != null ? String(value) : null);

const requireTenant = (tenantId) => {
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
};

const requireOrgScope = (scope) => {
    if (scope?.level !== RECRUITMENT_SCOPE.ORG) {
        throw fail("Only recruitment administrators can manage retention", 403, "HR-RECRUITMENT-PRIVACY-FORBIDDEN");
    }
};

const settingsLock = (tx, tenantId) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:recruitment-settings`}))`;

// ── Events (ids and counts only) ─────────────────────────────────────────────

/** hr.recruitment.retention_dry_run_report.v1 — the report to the data-policy owner. */
export function retentionDryRunReportEvent(run, { dataPolicyOwnerId = null } = {}) {
    if (!run?.tenantId) return null;
    const stored = readRunCandidates(run.candidateIds);
    return {
        eventName: RETENTION_DRY_RUN_REPORT_EVENT,
        tenantId: run.tenantId,
        aggregateType: "CandidateRetentionRun",
        aggregateId: run.id,
        actorId: null,
        payload: {
            runId: String(run.id),
            asOf: new Date(run.asOf).toISOString(),
            wouldAnonymize: Number(run.wouldAnonymize) || 0,
            suspendedByLegalHold: Number(run.suspendedByLegalHold) || 0,
            truncated: stored.truncated,
            limitReached: stored.limitReached,
            // The recipient (null: no owner yet, the hub falls back to the
            // tenant's HR admins).
            dataPolicyOwnerId: idStr(dataPolicyOwnerId),
            signoffWindowDays: SIGNOFF_MAX_AGE_DAYS,
        },
    };
}

/** hr.recruitment.retention_apply_changed.v1 — apply switched on (with the run) or off. */
export function retentionApplyChangedEvent({ tenantId, enabled, runId = null, actorId = null, dataPolicyOwnerId = null }) {
    if (!tenantId) return null;
    return {
        eventName: RETENTION_APPLY_CHANGED_EVENT,
        tenantId,
        aggregateType: "TenantRecruitmentSettings",
        aggregateId: tenantId,
        actorId: actorId ?? null,
        payload: {
            enabled: enabled === true,
            runId: idStr(runId),
            actorId: idStr(actorId),
            dataPolicyOwnerId: idStr(dataPolicyOwnerId),
        },
    };
}

// ── Settings ─────────────────────────────────────────────────────────────────

const RETENTION_SETTINGS_SELECT = Object.freeze({
    retentionApplyEnabled: true,
    retentionApplyEnabledAt: true,
    retentionApplyEnabledById: true,
    retentionSignoffRunId: true,
    dataPolicyOwnerId: true,
    version: true,
});

/** The tenant's retention switch and owner (defaults when never saved). */
export function presentRetentionState(row) {
    return {
        retentionApplyEnabled: row?.retentionApplyEnabled === true,
        retentionApplyEnabledAt: row?.retentionApplyEnabledAt ?? null,
        retentionApplyEnabledById: row?.retentionApplyEnabledById ?? null,
        retentionSignoffRunId: row?.retentionSignoffRunId ?? null,
        dataPolicyOwnerId: row?.dataPolicyOwnerId ?? null,
        version: row?.version ?? 0,
    };
}

async function readRetentionState(db, tenantId) {
    const row = await db.tenantRecruitmentSettings.findUnique({ where: { tenantId }, select: RETENTION_SETTINGS_SELECT });
    return presentRetentionState(row);
}

function writeRetentionSettings(tx, tenantId, data, actorId) {
    const write = { ...data, updatedById: actorId ?? null };
    return tx.tenantRecruitmentSettings.upsert({
        where: { tenantId },
        create: { tenantId, ...write, version: 1 },
        update: { ...write, version: { increment: 1 } },
        select: RETENTION_SETTINGS_SELECT,
    });
}

// ── The per-tenant run (called by the nightly job) ───────────────────────────

// The report event and the reportSentAt stamp, together or not at all.
async function sendDryRunReport(tenantId, run, state) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const event = await enqueueHrDomainEvent(tx, retentionDryRunReportEvent({ ...run, tenantId: run.tenantId ?? tenantId }, state));
            if (!event) return false;
            await tx.candidateRetentionRun.updateMany({
                where: withTenant(tenantId, { id: run.id, reportSentAt: null }),
                data: { reportSentAt: new Date() },
            });
            return true;
        },
        { tenantId },
    );
}

/**
 * Run retention for ONE tenant and record the run. Call under that tenant's
 * context. Never throws for a retention failure (the run is recorded FAILED);
 * it throws only when the run itself cannot be recorded.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {"off"|"dry-run"|"apply"} args.envMode  the resolved env mode
 * @param {Date} args.asOf
 * @param {number} [args.limit]
 * @returns {Promise<{ run: object, result: object|null, error: Error|null, reportSent: boolean }>}
 */
export async function runTenantRetention({ tenantId, envMode, asOf, limit = 100 } = {}) {
    requireTenant(tenantId);
    const at = new Date(asOf ?? Date.now());
    const state = await readRetentionState(prisma, tenantId);
    const intendedMode = decideTenantRunMode({
        envMode,
        flagOn: isRecruitmentFlagEnabled("retention"),
        tenantApplyEnabled: state.retentionApplyEnabled,
    });

    let result = null;
    let error = null;
    try {
        result = await applyRetention({ tenantId, asOf: at, dryRun: intendedMode !== RETENTION_RUN_MODE.APPLY, limit });
    } catch (err) {
        error = err;
        // The page HrRecruitmentRetentionRunFailed watches this outcome.
        recordRetentionRun("failed");
        log.error({ tenantId, intendedMode, errMessage: err?.message }, "retention run failed");
    }

    const { run, reportSent } = await recordRun({ tenantId, at, intendedMode, result, error, limit, state });
    return { run, result, error, reportSent };
}

/**
 * Record one run (the job's and a manual call's shared path) and, for a
 * completed dry-run, send its report. `signedOffById` stamps an APPLY run with
 * the employee who ran it by hand; a dry-run is never stamped, so it stays
 * open for the owner's sign-off.
 */
async function recordRun({ tenantId, at, intendedMode, result, error, limit, state, signedOffById = null }) {
    const data = buildRunRecord({ tenantId, asOf: at, intendedMode, result, error, limit });
    if (data.mode === RETENTION_RUN_MODE.APPLY && signedOffById) {
        data.signedOffById = signedOffById;
        data.signedOffAt = new Date();
    }
    // The run row is written on its own first: a report that cannot be sent
    // must never cost the record of what the run found.
    const run = await tenantTransaction(prisma, async (tx) => await tx.candidateRetentionRun.create({ data }), { tenantId });
    let reportSent = false;
    if (run.mode === RETENTION_RUN_MODE.DRY_RUN && run.status === RETENTION_RUN_STATUS.COMPLETED) {
        try {
            reportSent = await sendDryRunReport(tenantId, run, state);
            if (reportSent) run.reportSentAt = new Date();
        } catch (err) {
            // Left with reportSentAt null, visible on the runs list.
            log.error({ tenantId, runId: run.id, errMessage: err?.message }, "retention dry-run report not sent");
        }
    }
    return { run, reportSent };
}

/**
 * hr_candidate_retention_apply — a recruiter's manual run, recorded like the
 * nightly one (Phase 7: it was missing from the runs list).
 *
 * What gets anonymised is unchanged: applyRetention runs exactly as the tool
 * asked (dry-run unless dryRun is false) with its own gates (the flag and the
 * tenant's signed-off switch), and its result goes back to the caller as
 * before, with the run's id added. The run row is APPLY when it erased, signed
 * off by the caller (the employee who authorised that erasure); a dry-run,
 * also one an apply was refused into, is a DRY_RUN with its report sent to the
 * owner like the job's. A failure is recorded FAILED and then thrown.
 *
 * A run row that cannot be written does not undo an erasure that happened: the
 * result is still returned, with runId null, and the failure is logged.
 */
export async function runManualRetention({ tenantId, actorId = null, dryRun = true, asOf, limit = 100 } = {}) {
    requireTenant(tenantId);
    const at = new Date(asOf ?? Date.now());
    const wantsApply = dryRun === false;
    const actor = positiveInt(actorId);
    const intendedMode = wantsApply ? RETENTION_RUN_MODE.APPLY : RETENTION_RUN_MODE.DRY_RUN;

    let result = null;
    let error = null;
    try {
        result = await applyRetention({ tenantId, asOf: at, actorId: actor, dryRun: !wantsApply, limit });
    } catch (err) {
        error = err;
        recordRetentionRun("failed");
        log.error({ tenantId, intendedMode, errMessage: err?.message }, "manual retention run failed");
    }

    let run = null;
    try {
        const state = await readRetentionState(prisma, tenantId);
        ({ run } = await recordRun({ tenantId, at, intendedMode, result, error, limit, state, signedOffById: actor }));
    } catch (err) {
        log.error({ tenantId, intendedMode, errMessage: err?.message }, "manual retention run not recorded");
    }
    if (error) throw error;
    log.info({ tenantId, runId: run?.id ?? null, mode: run?.mode ?? intendedMode, actorId: actor }, "manual retention run recorded");
    return { ...result, runId: run?.id ?? null, runMode: run?.mode ?? null };
}

// ── Tools ────────────────────────────────────────────────────────────────────

const RUN_LIST_SELECT = Object.freeze({
    id: true,
    mode: true,
    status: true,
    asOf: true,
    wouldAnonymize: true,
    anonymized: true,
    suspendedByLegalHold: true,
    error: true,
    reportSentAt: true,
    signedOffById: true,
    signedOffAt: true,
    createdAt: true,
});

const clamp = (value, fallback, max) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** hr_candidate_retention_runs_list — newest first, counts only, plus the switch. */
export async function listRetentionRuns({ tenantId, scope, mode = null, status = null, page = 1, limit = 20 } = {}) {
    requireTenant(tenantId);
    requireOrgScope(scope);
    if (mode && !Object.values(RETENTION_RUN_MODE).includes(mode)) {
        throw fail("mode must be DRY_RUN or APPLY", 400, "HR-RECRUITMENT-RETENTION-FILTER-INVALID");
    }
    if (status && !Object.values(RETENTION_RUN_STATUS).includes(status)) {
        throw fail("status must be COMPLETED or FAILED", 400, "HR-RECRUITMENT-RETENTION-FILTER-INVALID");
    }
    const take = clamp(limit, 20, 100);
    const pageNo = clamp(page, 1, 10_000);
    const where = withTenant(tenantId, { ...(mode ? { mode } : {}), ...(status ? { status } : {}) });
    const [items, total, state] = await Promise.all([
        prisma.candidateRetentionRun.findMany({
            where,
            select: RUN_LIST_SELECT,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (pageNo - 1) * take,
            take,
        }),
        prisma.candidateRetentionRun.count({ where }),
        readRetentionState(prisma, tenantId),
    ]);
    return { items, total, page: pageNo, limit: take, retention: state };
}

/** hr_candidate_retention_run_get — counts, ids, legal-hold suspensions, sign-off eligibility. */
export async function getRetentionRun({ tenantId, scope, runId, now = new Date() } = {}) {
    requireTenant(tenantId);
    requireOrgScope(scope);
    const id = positiveInt(runId);
    const run = id ? await prisma.candidateRetentionRun.findFirst({ where: withTenant(tenantId, { id }) }) : null;
    if (!run) throw fail("Retention run not found", 404, "HR-RECRUITMENT-RETENTION-RUN-NOT-FOUND");
    const state = await readRetentionState(prisma, tenantId);
    const stored = readRunCandidates(run.candidateIds);
    const refusal = signoffRefusal(run, { now });
    const { candidateIds: _ids, tenantId: _tenant, ...rest } = run;
    return {
        ...rest,
        candidateIds: stored.ids,
        legalHoldSuspensions: stored.held,
        truncated: stored.truncated,
        limitReached: stored.limitReached,
        refusedReason: stored.refusedReason,
        signoff: {
            eligible: refusal === null,
            reason: refusal?.code ?? null,
            isCurrentSignoff: state.retentionSignoffRunId === run.id && state.retentionApplyEnabled,
        },
        retention: state,
    };
}

const requireManager = (user, state, { requireActor = false } = {}) => {
    if (!canManageRetention({ user, ownerId: state?.dataPolicyOwnerId })) {
        throw fail(
            state?.dataPolicyOwnerId
                ? "Only the tenant's data-policy owner can change retention apply"
                : "Only an administrator can change retention apply until a data-policy owner is named",
            403,
            "HR-RECRUITMENT-RETENTION-OWNER-REQUIRED",
        );
    }
    const actorId = positiveInt(user?.employeeId);
    if (requireActor && !actorId) {
        throw fail("A sign-off must be attributable to an employee", 403, "HR-RECRUITMENT-RETENTION-ACTOR-REQUIRED");
    }
    return actorId;
};

const audit = (tenantId, actorId, notes) =>
    logAction({ employeeId: actorId, type: "Update", module: "Candidate Retention", result: "SUCCESS", notes, tenantId }).catch(
        (err) => log.warn({ tenantId, errMessage: err?.message }, "retention audit log write failed"),
    );

/**
 * hr_candidate_retention_signoff — sign off a recent completed dry-run and
 * switch apply on for the tenant.
 */
export async function signOffRetentionRun({ tenantId, user, scope, runId, expectedVersion, now = new Date() } = {}) {
    requireTenant(tenantId);
    requireOrgScope(scope);
    if (!isRecruitmentFlagEnabled("retention")) {
        throw fail("Retention automation is disabled", 503, "HR-RECRUITMENT-RETENTION-DISABLED");
    }
    const id = positiveInt(runId);
    if (!id) throw fail("Retention run not found", 404, "HR-RECRUITMENT-RETENTION-RUN-NOT-FOUND");
    const at = new Date(now);

    const outcome = await tenantTransaction(
        prisma,
        async (tx) => {
            await settingsLock(tx, tenantId);
            const state = await readRetentionState(tx, tenantId);
            const actorId = requireManager(user, state, { requireActor: true });
            if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== state.version) {
                throw fail("Recruitment settings changed; refresh before signing off", 409, "HR-RECRUITMENT-SETTINGS-VERSION-CONFLICT");
            }
            const run = await tx.candidateRetentionRun.findFirst({ where: withTenant(tenantId, { id }) });
            if (!run) throw fail("Retention run not found", 404, "HR-RECRUITMENT-RETENTION-RUN-NOT-FOUND");
            // A repeated call for the sign-off already in force replays.
            if (run.signedOffAt && state.retentionApplyEnabled && state.retentionSignoffRunId === run.id) {
                return { replayed: true, run, state, actorId };
            }
            const refusal = signoffRefusal(run, { now: at });
            if (refusal) throw fail(refusal.message, 409, refusal.code);

            const claim = await tx.candidateRetentionRun.updateMany({
                where: withTenant(tenantId, {
                    id: run.id,
                    mode: RETENTION_RUN_MODE.DRY_RUN,
                    status: RETENTION_RUN_STATUS.COMPLETED,
                    signedOffAt: null,
                }),
                data: { signedOffById: actorId, signedOffAt: at },
            });
            if (Number(claim?.count ?? 0) !== 1) {
                throw fail("This dry-run has already been signed off", 409, "HR-RECRUITMENT-RETENTION-RUN-ALREADY-SIGNED-OFF");
            }
            const saved = await writeRetentionSettings(
                tx,
                tenantId,
                {
                    retentionApplyEnabled: true,
                    retentionApplyEnabledAt: at,
                    retentionApplyEnabledById: actorId,
                    retentionSignoffRunId: run.id,
                },
                actorId,
            );
            await enqueueHrDomainEvent(
                tx,
                retentionApplyChangedEvent({ tenantId, enabled: true, runId: run.id, actorId, dataPolicyOwnerId: state.dataPolicyOwnerId }),
            );
            return { replayed: false, run: { ...run, signedOffById: actorId, signedOffAt: at }, state: presentRetentionState(saved), actorId };
        },
        { tenantId },
    );

    if (!outcome.replayed) {
        await audit(
            tenantId,
            outcome.actorId,
            `Retention dry-run ${outcome.run.id} signed off; apply enabled (would anonymize ${outcome.run.wouldAnonymize}, held ${outcome.run.suspendedByLegalHold}).`,
        );
        log.info({ tenantId, runId: outcome.run.id, actorId: outcome.actorId }, "retention apply enabled after sign-off");
    }
    return {
        runId: outcome.run.id,
        signedOffById: outcome.run.signedOffById,
        signedOffAt: outcome.run.signedOffAt,
        replayed: outcome.replayed,
        retention: outcome.state,
    };
}

/** hr_candidate_retention_apply_disable — apply off at once (idempotent), audited. */
export async function disableRetentionApply({ tenantId, user, scope, reason = null } = {}) {
    requireTenant(tenantId);
    requireOrgScope(scope);
    const note = typeof reason === "string" ? reason.trim().slice(0, 500) : "";

    const outcome = await tenantTransaction(
        prisma,
        async (tx) => {
            await settingsLock(tx, tenantId);
            const state = await readRetentionState(tx, tenantId);
            const actorId = requireManager(user, state);
            if (!state.retentionApplyEnabled) return { changed: false, state, actorId };
            const saved = await writeRetentionSettings(
                tx,
                tenantId,
                { retentionApplyEnabled: false, retentionApplyEnabledAt: null, retentionApplyEnabledById: null },
                actorId,
            );
            await enqueueHrDomainEvent(
                tx,
                retentionApplyChangedEvent({
                    tenantId,
                    enabled: false,
                    runId: state.retentionSignoffRunId,
                    actorId,
                    dataPolicyOwnerId: state.dataPolicyOwnerId,
                }),
            );
            return { changed: true, state: presentRetentionState(saved), actorId };
        },
        { tenantId },
    );

    if (outcome.changed) {
        await audit(tenantId, outcome.actorId, `Retention apply disabled${note ? `: ${note}` : ""}.`);
        log.info({ tenantId, actorId: outcome.actorId }, "retention apply disabled");
    }
    return { changed: outcome.changed, retention: outcome.state };
}

/** hr_candidate_retention_owner_set — name the tenant's data-policy owner (ORG admin). */
export async function setDataPolicyOwner({ tenantId, user, scope, employeeId } = {}) {
    requireTenant(tenantId);
    requireOrgScope(scope);
    if (user?.isAdmin !== true) {
        throw fail("Only an administrator can name the data-policy owner", 403, "HR-RECRUITMENT-RETENTION-ADMIN-REQUIRED");
    }
    const ownerId = positiveInt(employeeId);
    if (!ownerId) throw fail("A valid employee id is required", 400, "HR-RECRUITMENT-RETENTION-OWNER-INVALID");
    const actorId = positiveInt(user?.employeeId);

    const outcome = await tenantTransaction(
        prisma,
        async (tx) => {
            const employee = await tx.employee.findFirst({ where: { id: ownerId, tenant_id: tenantId }, select: { id: true } });
            if (!employee) throw fail("Employee not found", 404, "HR-RECRUITMENT-RETENTION-OWNER-NOT-FOUND");
            await settingsLock(tx, tenantId);
            const state = await readRetentionState(tx, tenantId);
            if (state.dataPolicyOwnerId === ownerId) return { changed: false, previous: ownerId, state };
            const saved = await writeRetentionSettings(tx, tenantId, { dataPolicyOwnerId: ownerId }, actorId);
            return { changed: true, previous: state.dataPolicyOwnerId, state: presentRetentionState(saved) };
        },
        { tenantId },
    );

    if (outcome.changed) {
        await audit(tenantId, actorId, `Data-policy owner set to employee ${ownerId} (was ${outcome.previous ?? "none"}).`);
    }
    return { changed: outcome.changed, retention: outcome.state };
}
