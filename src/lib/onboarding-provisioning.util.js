// src/lib/onboarding-provisioning.util.js
//
// Recruitment Phase 4 (plan 6.7, "Provisioning tasks") — the rules behind the
// requests to IT that day one needs: an account, a mailbox, a device, system
// access or a workspace. A checklist task of category IT_ACCESS_SETUP or
// WORKSPACE_EQUIPMENT raises one request; fulfilling the request completes the
// task, and completing or reopening the task from the onboarding screens keeps
// the request in step.
//
// Pure functions only (src/lib may not import src/services). The vocabularies
// mirror the CHECKs in migration 20261021003600_onboarding_handoff_automation.

export const PROVISIONING_KINDS = Object.freeze(["ACCOUNT", "EMAIL", "DEVICE", "ACCESS", "WORKSPACE", "OTHER"]);

export const PROVISIONING_STATUS = Object.freeze({
    REQUESTED: "REQUESTED",
    IN_PROGRESS: "IN_PROGRESS",
    FULFILLED: "FULFILLED",
    REJECTED: "REJECTED",
    CANCELLED: "CANCELLED",
});
export const PROVISIONING_STATUSES = Object.freeze(Object.values(PROVISIONING_STATUS));

/** Statuses IT still has to act on; overdue and cancellable apply only here. */
export const OPEN_PROVISIONING_STATUSES = Object.freeze([PROVISIONING_STATUS.REQUESTED, PROVISIONING_STATUS.IN_PROGRESS]);

/** Task categories whose tasks are requests to IT. */
export const PROVISIONING_TASK_CATEGORIES = Object.freeze(["IT_ACCESS_SETUP", "WORKSPACE_EQUIPMENT"]);

// The column limits (CHECK onboarding_provisioning_requests_text_check).
export const PROVISIONING_TITLE_MAX = 200;
export const PROVISIONING_NOTES_MAX = 2000;
export const PROVISIONING_EXTERNAL_REF_MAX = 200;

// REQUESTED → IN_PROGRESS → FULFILLED | REJECTED, and any open status →
// CANCELLED. IT may also close a REQUESTED one directly (FULFILLED or
// REJECTED), so a quick request is one call; acknowledgedAt is stamped then.
// Terminal statuses never move through the request tool; the only way back
// from FULFILLED is the task reopen sync (syncTargetForTask below).
const TRANSITIONS = Object.freeze({
    REQUESTED: Object.freeze(["IN_PROGRESS", "FULFILLED", "REJECTED", "CANCELLED"]),
    IN_PROGRESS: Object.freeze(["FULFILLED", "REJECTED", "CANCELLED"]),
    FULFILLED: Object.freeze([]),
    REJECTED: Object.freeze([]),
    CANCELLED: Object.freeze([]),
});

export const isOpenProvisioningStatus = (status) => OPEN_PROVISIONING_STATUSES.includes(status);

/** The statuses `from` may move to through the request tool. */
export const allowedProvisioningTransitions = (from) => TRANSITIONS[from] ?? [];

export const canTransitionProvisioning = (from, to) => allowedProvisioningTransitions(from).includes(to);

/**
 * Does this checklist task raise a request to IT? Its category is IT or
 * workspace, it is not already done, and it is not the new hire's own task
 * (the baseline's "Confirm day-one system access" is the hire checking, not a
 * request to IT).
 */
export function qualifiesForProvisioning(task) {
    if (!task || !PROVISIONING_TASK_CATEGORIES.includes(task.category)) return false;
    if (task.completed === true) return false;
    return task.assigneeType !== "NEW_HIRE";
}

// Title keywords, first match wins. Ordered so the specific asks beat the
// generic ones: "work email and system accounts" is a mailbox first,
// "workspace and access badge" is a desk, not a system grant.
const KIND_KEYWORDS = Object.freeze([
    ["EMAIL", /\b(e-?mail|mail ?box|mail account|inbox|distribution list)\b/i],
    ["DEVICE", /\b(laptop|desktop|computer|machine|device|phone|mobile|monitor|tablet|headset|peripherals?|hardware|sim)\b/i],
    ["WORKSPACE", /\b(workspace|work space|desk|seat|badge|locker|parking|furniture)\b/i],
    ["ACCOUNT", /\b(accounts?|login|log-in|credentials?|username|user id|directory|sso|password)\b/i],
    ["ACCESS", /\b(access|permissions?|vpn|role|license|licence|system|application|repository|repo)\b/i],
]);

const CATEGORY_KIND = Object.freeze({ IT_ACCESS_SETUP: "ACCESS", WORKSPACE_EQUIPMENT: "WORKSPACE" });

/**
 * ACCOUNT | EMAIL | DEVICE | ACCESS | WORKSPACE | OTHER for a task, from its
 * title keywords, else its category, else OTHER.
 */
export function provisioningKindFor(task) {
    const title = String(task?.title ?? "");
    for (const [kind, pattern] of KIND_KEYWORDS) {
        if (pattern.test(title)) return kind;
    }
    return CATEGORY_KIND[task?.category] ?? "OTHER";
}

const DAY_MS = 24 * 60 * 60 * 1000;

const asDate = (value) => {
    if (value == null || value === "") return null;
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The request's due date: the task's own due date, else the day before the
 * start date (IT must be done before day one), else none.
 */
export function provisioningDueDate({ taskDueDate, startDate } = {}) {
    const own = asDate(taskDueDate);
    if (own) return own;
    const start = asDate(startDate);
    return start ? new Date(start.getTime() - DAY_MS) : null;
}

/** Open and past its due date. A request with no due date is never overdue. */
export function isProvisioningOverdue(request, now = new Date()) {
    if (!request || !isOpenProvisioningStatus(request.status)) return false;
    const due = asDate(request.dueDate);
    return Boolean(due) && due.getTime() < asDate(now).getTime();
}

/** The request title from the task title, within the column limit. */
export function provisioningTitleFor(task) {
    const title = String(task?.title ?? "").trim();
    return (title || "Provisioning request").slice(0, PROVISIONING_TITLE_MAX);
}

/**
 * Where the request goes when its task is completed or reopened elsewhere.
 *   * completed: an open request is FULFILLED;
 *   * reopened: a request FULFILLED by that sync goes back to IN_PROGRESS. The
 *     sync records no fulfilledById (the marker); a request IT fulfilled
 *     through the request tool carries IT's id and stays FULFILLED.
 * @returns {string|null} the target status, or null for no change
 */
export function syncTargetForTask(request, completed) {
    if (!request) return null;
    if (completed) return isOpenProvisioningStatus(request.status) ? PROVISIONING_STATUS.FULFILLED : null;
    if (request.status === PROVISIONING_STATUS.FULFILLED && request.fulfilledById == null) return PROVISIONING_STATUS.IN_PROGRESS;
    return null;
}

// ── Who is calling (role claims) ─────────────────────────────────────────────
// IT staff work the request queue with the hr:onboarding grant. Inside it, a
// caller whose roles are IT only (no HR role) may acknowledge, fulfil or reject
// a request and record its reference and notes, but may not cancel one: that a
// hire no longer needs something is HR's call.
export const PROVISIONING_IT_ROLES = Object.freeze(["IT", "IT_ADMIN", "IT_SUPPORT", "IT_STAFF", "IT_HELPDESK", "HELPDESK", "SYSADMIN"]);
export const PROVISIONING_HR_ROLES = Object.freeze(["HR", "HR_ADMIN", "HR_MANAGER", "HR_OFFICER", "HR_EXECUTIVE", "HR_GENERALIST", "RBAC_ADMIN"]);

const rolesOfUser = (user) => {
    const raw = user?.roles;
    const list = Array.isArray(raw) ? [...raw] : raw ? [raw] : [];
    if (!list.length && user?.role) list.push(user.role);
    return list.map((role) => String(role ?? "").trim().toUpperCase()).filter(Boolean);
};

/**
 * @param {object} user - verified actor ({ roles|role, employeeId })
 * @returns {{ employeeId: number|null, itOnly: boolean, canCancel: boolean }}
 */
export function resolveProvisioningActor(user) {
    const roles = rolesOfUser(user);
    const it = roles.some((role) => PROVISIONING_IT_ROLES.includes(role));
    const hr = roles.some((role) => PROVISIONING_HR_ROLES.includes(role));
    const id = Number(user?.employeeId);
    const itOnly = it && !hr;
    return { employeeId: Number.isInteger(id) && id > 0 ? id : null, itOnly, canCancel: !itOnly };
}
