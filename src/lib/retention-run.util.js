// src/lib/retention-run.util.js
//
// Recruitment Phase 5 (plan 6.9) — the pure rules behind the per-tenant
// retention runs. No DB and no I/O, so the decisions that guard an
// irreversible erasure are pinned by unit tests on their own:
//
//   * resolveRetentionMode    the env mode (off | dry-run | apply); anything
//       unrecognised is dry-run, so a typo can never turn erasure on.
//   * decideTenantRunMode     a tenant APPLIES only when all three agree: the
//       env mode is apply, the retention flag is on, and that tenant's
//       data-policy owner switched apply on (retentionApplyEnabled) after
//       signing off a dry-run. Any one missing means a dry-run.
//   * buildRunRecord          the CandidateRetentionRun row for one tenant's
//       result (or failure): counts, a capped id list, the legal-hold
//       suspensions, the error text.
//   * signoffRefusal          why a run cannot be signed off: not a dry-run,
//       failed, older than the sign-off window, or already signed off.
//   * canManageRetention      the caller is the tenant's data-policy owner, or
//       an admin while no owner is set.

export const RETENTION_RUN_MODE = Object.freeze({ DRY_RUN: "DRY_RUN", APPLY: "APPLY" });
export const RETENTION_RUN_STATUS = Object.freeze({ COMPLETED: "COMPLETED", FAILED: "FAILED" });
export const RETENTION_ENV_MODES = Object.freeze(["off", "dry-run", "apply"]);

// A dry-run report older than this no longer describes what apply would do.
export const SIGNOFF_MAX_AGE_DAYS = 7;
// How many candidate ids (and held ids) a run row keeps; the counts stay exact.
export const RUN_ID_CAP = 500;
const RUN_ERROR_MAX = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** { requested, resolved } — resolved is one of RETENTION_ENV_MODES. */
export function resolveRetentionMode(raw) {
    const requested = String(raw ?? "").trim().toLowerCase() || "dry-run";
    const resolved = RETENTION_ENV_MODES.includes(requested) ? requested : "dry-run";
    return { requested, resolved };
}

/** DRY_RUN unless the env mode, the flag and the tenant's switch all say apply. */
export function decideTenantRunMode({ envMode, flagOn, tenantApplyEnabled } = {}) {
    return envMode === "apply" && flagOn === true && tenantApplyEnabled === true
        ? RETENTION_RUN_MODE.APPLY
        : RETENTION_RUN_MODE.DRY_RUN;
}

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/** The first `cap` distinct positive ids, with the full count. */
export function capIds(ids, cap = RUN_ID_CAP) {
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map(positiveInt).filter(Boolean))];
    return { ids: unique.slice(0, cap), total: unique.length, truncated: unique.length > cap };
}

// applyRetention reports ids for the affected set and rows for the held set.
const heldEntries = (held) =>
    (Array.isArray(held) ? held : [])
        .map((row) => ({ candidateId: positiveInt(row?.id ?? row?.candidateId), legalHoldId: positiveInt(row?.legalHoldId) }))
        .filter((row) => row.candidateId);

const errorText = (error) => {
    const text = String(error?.message ?? error ?? "unknown").trim() || "unknown";
    return text.length > RUN_ERROR_MAX ? `${text.slice(0, RUN_ERROR_MAX - 1)}…` : text;
};

/**
 * The CandidateRetentionRun create data for one tenant.
 *
 * The mode is what applyRetention actually DID (its own gates can still turn
 * an apply into a dry-run), falling back to the intended mode for a failure.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {Date} args.asOf
 * @param {string} args.intendedMode  RETENTION_RUN_MODE
 * @param {object} [args.result]      applyRetention's result
 * @param {Error} [args.error]        the failure, when it threw
 */
export function buildRunRecord({ tenantId, asOf, intendedMode, result = null, error = null, limit = null } = {}) {
    if (error || !result) {
        return {
            tenantId,
            mode: intendedMode === RETENTION_RUN_MODE.APPLY ? RETENTION_RUN_MODE.APPLY : RETENTION_RUN_MODE.DRY_RUN,
            status: RETENTION_RUN_STATUS.FAILED,
            asOf,
            wouldAnonymize: 0,
            anonymized: 0,
            suspendedByLegalHold: 0,
            candidateIds: { ids: [], held: [], truncated: false },
            error: errorText(error ?? "no result"),
        };
    }
    const dryRun = result.dryRun !== false;
    const affected = capIds(dryRun ? result.wouldAnonymize : result.anonymized);
    const held = heldEntries(result.suspendedByLegalHold);
    const heldCapped = held.slice(0, RUN_ID_CAP);
    // The service reads at most `limit` due rows per run: a run that filled
    // its window may not have seen every due candidate (the next run will).
    const cap = Number(limit);
    const limitReached = Number.isInteger(cap) && cap > 0 && affected.total + held.length >= Math.min(cap, 500);
    return {
        tenantId,
        mode: dryRun ? RETENTION_RUN_MODE.DRY_RUN : RETENTION_RUN_MODE.APPLY,
        status: RETENTION_RUN_STATUS.COMPLETED,
        asOf,
        wouldAnonymize: dryRun ? affected.total : 0,
        anonymized: dryRun ? 0 : affected.total,
        suspendedByLegalHold: held.length,
        candidateIds: {
            ids: affected.ids,
            held: heldCapped,
            truncated: affected.truncated || held.length > heldCapped.length,
            limitReached,
            // An apply the service refused (flag or tenant switch) is recorded
            // as the dry-run it became, with the reason.
            ...(result.refused ? { refusedReason: String(result.reason ?? "refused") } : {}),
        },
        error: null,
    };
}

/** The stored candidateIds JSON, normalised (older or partial rows read safely). */
export function readRunCandidates(json) {
    const value = json && typeof json === "object" ? json : {};
    if (Array.isArray(value)) return { ids: capIds(value).ids, held: [], truncated: false, limitReached: false, refusedReason: null };
    return {
        ids: capIds(value.ids).ids,
        held: heldEntries(value.held),
        truncated: value.truncated === true,
        limitReached: value.limitReached === true,
        refusedReason: value.refusedReason ?? null,
    };
}

/**
 * Why this run cannot be signed off, or null when it can.
 * @returns {{ code: string, message: string } | null}
 */
export function signoffRefusal(run, { now = new Date(), maxAgeDays = SIGNOFF_MAX_AGE_DAYS } = {}) {
    if (!run) return { code: "HR-RECRUITMENT-RETENTION-RUN-NOT-FOUND", message: "Retention run not found" };
    if (run.mode !== RETENTION_RUN_MODE.DRY_RUN) {
        return { code: "HR-RECRUITMENT-RETENTION-RUN-NOT-DRY-RUN", message: "Only a dry-run report can be signed off" };
    }
    if (run.status !== RETENTION_RUN_STATUS.COMPLETED) {
        return { code: "HR-RECRUITMENT-RETENTION-RUN-FAILED", message: "This dry-run failed; sign off a run that completed" };
    }
    const createdAt = new Date(run.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt.getTime() < new Date(now).getTime() - maxAgeDays * DAY_MS) {
        return {
            code: "HR-RECRUITMENT-RETENTION-RUN-STALE",
            message: `This dry-run is older than ${maxAgeDays} days; sign off a recent report`,
        };
    }
    if (run.signedOffAt) {
        return { code: "HR-RECRUITMENT-RETENTION-RUN-ALREADY-SIGNED-OFF", message: "This dry-run has already been signed off" };
    }
    return null;
}

/**
 * The data-policy owner decides; while none is set, an admin does (and is
 * expected to name the owner).
 */
export function canManageRetention({ user, ownerId } = {}) {
    const owner = positiveInt(ownerId);
    if (owner) return positiveInt(user?.employeeId) === owner;
    return user?.isAdmin === true;
}
