// src/lib/internal-mobility.util.js
//
// Recruitment Phase 5 (plan 6.2) — the internal job board and employee
// referrals: the vocabularies, the rules and the shapes, as pure functions.
//
// Why a lib and not inline in the services: three callers answer the same
// questions. The board service decides which requisitions an employee may see
// and apply to, the referral service keeps a referral in step with its
// application and runs the bonus clock, and the tools validate the same
// vocabularies at the boundary. A referral that is "HIRED" on one path and
// "IN_PROCESS" on another is what one module prevents.
//
// No DB and no I/O here (src/lib may not import src/services).
import { INTERNAL_BOARD_CHANNELS } from "./requisitionPublication.js";
import { APPLICATION_ACCEPTING_STATUSES } from "./requisitionEligibility.js";

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

// ── Referral and bonus vocabularies (mirrors internal_referrals_status_check) ──

export const REFERRAL_STATUS = Object.freeze({
    SUBMITTED: "SUBMITTED",
    IN_PROCESS: "IN_PROCESS",
    HIRED: "HIRED",
    REJECTED: "REJECTED",
    WITHDRAWN: "WITHDRAWN",
    DUPLICATE: "DUPLICATE",
});
export const REFERRAL_STATUSES = Object.freeze(Object.values(REFERRAL_STATUS));

// The statuses an application stage move may still change. HIRED, REJECTED and
// WITHDRAWN follow terminal application stages; DUPLICATE never had an
// application of its own.
export const OPEN_REFERRAL_STATUSES = Object.freeze([REFERRAL_STATUS.SUBMITTED, REFERRAL_STATUS.IN_PROCESS]);

export const BONUS_STATUS = Object.freeze({
    NOT_ELIGIBLE: "NOT_ELIGIBLE",
    PENDING: "PENDING",
    ELIGIBLE: "ELIGIBLE",
    APPROVED: "APPROVED",
    PAID: "PAID",
    FORFEITED: "FORFEITED",
});
export const BONUS_STATUSES = Object.freeze(Object.values(BONUS_STATUS));

// The decisions HR takes on a bonus, and the statuses each may be taken from.
// PENDING -> ELIGIBLE belongs to the clock (runReferralBonusJob), never to a
// person: an approval before the wait is over would be paying for a hire that
// may not stay.
export const BONUS_DECISIONS = Object.freeze({
    [BONUS_STATUS.APPROVED]: Object.freeze([BONUS_STATUS.ELIGIBLE]),
    [BONUS_STATUS.PAID]: Object.freeze([BONUS_STATUS.APPROVED]),
    [BONUS_STATUS.FORFEITED]: Object.freeze([BONUS_STATUS.ELIGIBLE, BONUS_STATUS.APPROVED]),
});
export const BONUS_DECISION_TARGETS = Object.freeze(Object.keys(BONUS_DECISIONS));

// Coded, because "why was this bonus not paid" is a report. OTHER needs a note.
export const BONUS_FORFEIT_REASONS = Object.freeze([
    "HIRE_SEPARATED", // the referred hire left (the clock sets this one itself)
    "REFERRER_SEPARATED",
    "POLICY_INELIGIBLE", // e.g. the referrer is in the hiring chain for the role
    "DUPLICATE_CLAIM",
    "OTHER",
]);

export const REFERRAL_NOTE_MAX_LENGTH = 2000; // internal_referrals CHECK
export const REFERRAL_RELATIONSHIP_MAX_LENGTH = 100;
export const REFERRAL_NAME_MAX_LENGTH = 100;
export const FORFEIT_NOTE_MAX_LENGTH = 500;

/** The sourceDetail a referral's application carries (an id, never PII). */
export const referralSourceDetail = (referralId) => `referral:${referralId}`;

/**
 * The referral status an application stage implies, or null when the stage
 * says nothing new ("applied" is where a referral starts).
 */
export function referralStatusForStage(stage) {
    switch (String(stage ?? "").trim().toLowerCase()) {
        case "screening":
        case "interview":
        case "offer":
        case "on_hold":
            return REFERRAL_STATUS.IN_PROCESS;
        case "hired":
            return REFERRAL_STATUS.HIRED;
        case "rejected":
            return REFERRAL_STATUS.REJECTED;
        case "withdrawn":
            return REFERRAL_STATUS.WITHDRAWN;
        default:
            return null;
    }
}

/** Refuse a bonus decision the rules do not allow from the current status. */
export function assertBonusTransition(from, to) {
    const target = String(to ?? "").trim().toUpperCase();
    const allowed = BONUS_DECISIONS[target];
    if (!allowed) {
        throw fail(
            `bonusStatus must be one of: ${BONUS_DECISION_TARGETS.join(", ")}`,
            400,
            "HR-RECRUITMENT-REFERRAL-BONUS-INVALID",
        );
    }
    if (!allowed.includes(from)) {
        throw fail(
            `A ${from} referral bonus cannot become ${target}`,
            409,
            "HR-RECRUITMENT-REFERRAL-BONUS-TRANSITION",
            { from, to: target, allowedFrom: [...allowed] },
        );
    }
    return target;
}

/** A coded forfeit reason (OTHER needs a note). */
export function normalizeForfeitReason(reason, note) {
    const code = String(reason ?? "").trim().toUpperCase();
    if (!BONUS_FORFEIT_REASONS.includes(code)) {
        throw fail(
            `reason must be one of: ${BONUS_FORFEIT_REASONS.join(", ")}`,
            400,
            "HR-RECRUITMENT-REFERRAL-FORFEIT-REASON-INVALID",
        );
    }
    const text = note == null ? "" : String(note).trim();
    if (code === "OTHER" && !text) {
        throw fail("reason OTHER needs a note saying why", 400, "HR-RECRUITMENT-REFERRAL-FORFEIT-REASON-INVALID");
    }
    return { reason: code, note: text ? text.slice(0, FORFEIT_NOTE_MAX_LENGTH) : null };
}

/** A non-negative amount with at most two decimals, as a string for Decimal. */
export function normalizeBonusAmount(value) {
    const text = String(value ?? "").trim();
    if (!/^\d{1,16}(\.\d{1,2})?$/.test(text)) {
        throw fail("amount must be a non-negative number with at most two decimals", 400, "HR-RECRUITMENT-REFERRAL-BONUS-AMOUNT-INVALID");
    }
    return text;
}

/** An ISO 4217-shaped currency code. */
export function normalizeCurrency(value) {
    const code = String(value ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
        throw fail("currency must be a three-letter ISO code", 400, "HR-RECRUITMENT-REFERRAL-BONUS-CURRENCY-INVALID");
    }
    return code;
}

// ── Dates and employment ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export const addDays = (date, days) => new Date(new Date(date).getTime() + Number(days) * DAY_MS);

// The status words that mean "no longer works here". The fleet stores status
// as free text in two columns (status, employement_status); the assessment
// module reads them the same way.
const SEPARATED_RE = /inactive|terminated|exited|offboard|separated|resigned|deceased/i;

/**
 * Whether an employee still works for the tenant at `now`. A separation date
 * in the future is a notice period: still employed until it passes.
 */
export function isStillEmployed(employee, now = new Date()) {
    if (!employee) return false;
    if (employee.separatedAt && new Date(employee.separatedAt).getTime() <= new Date(now).getTime()) return false;
    return !SEPARATED_RE.test(`${employee.status ?? ""} ${employee.employement_status ?? ""}`);
}

export const normalizeEmail = (value) => {
    const text = String(value ?? "").trim().toLowerCase();
    return text || null;
};

/** The employee's addresses in match order: work email, then personal email. */
export function employeeEmails(employee) {
    const list = [normalizeEmail(employee?.work_email), normalizeEmail(employee?.email)].filter(Boolean);
    return [...new Set(list)];
}

/** The employee's name split for a Candidate row. */
export function employeeName(employee) {
    const first = String(employee?.first_name ?? "").trim();
    const last = String(employee?.last_name ?? "").trim();
    if (first) return { firstName: first, lastName: last || null };
    const [head, ...rest] = String(employee?.employee_name ?? "").trim().split(/\s+/);
    return { firstName: head || "Employee", lastName: rest.join(" ") || null };
}

// ── The board ──────────────────────────────────────────────────────────────

/**
 * The tenant-scoped where-clause for the requisitions one employee may see on
 * the internal board at `now`:
 *   * in an accepting state (APPROVED or POSTED) with the window still open;
 *   * with at least one live CAREER_SITE or INTERNAL posting;
 *   * NOT one the employee owns (hiring manager, recruiter) or is being
 *     replaced on. The owner manages that opening through the recruitment
 *     tools, and applying to or being paid a referral bonus on your own
 *     opening is a conflict of interest; the replacement case would tell
 *     someone their own replacement is being hired.
 * The NULL halves are spelled out: `{ not: id }` alone does not match a NULL
 * recruiterId or replacementEmployeeId in SQL.
 */
export function boardRequisitionWhere({ tenantId, employeeId, now = new Date() }) {
    const notMine = (column) => ({ OR: [{ [column]: null }, { [column]: { not: employeeId } }] });
    return {
        tenantId,
        status: { in: [...APPLICATION_ACCEPTING_STATUSES] },
        requestedById: { not: employeeId },
        AND: [
            { OR: [{ closesAt: null }, { closesAt: { gte: now } }] },
            notMine("recruiterId"),
            notMine("replacementEmployeeId"),
        ],
        postings: {
            some: { tenantId, channel: { in: [...INTERNAL_BOARD_CHANNELS] }, isActive: true, closedAt: null },
        },
    };
}

// The ONLY requisition fields the board reads: no grade or salary band, no
// budget or cost centre, no approval snapshot, no notes or attachments.
export const boardRequisitionSelect = (tenantId) => ({
    id: true,
    title: true,
    departmentId: true,
    location: true,
    employmentType: true,
    openings: true,
    closesAt: true,
    publishedAt: true,
    description: true,
    jobContent: true,
    postings: {
        where: { tenantId, channel: { in: [...INTERNAL_BOARD_CHANNELS] }, isActive: true, closedAt: null },
        select: { id: true, channel: true, postedAt: true },
        orderBy: { postedAt: "asc" },
    },
});

const listOf = (value) => (Array.isArray(value) ? value.map((v) => String(v ?? "").trim()).filter(Boolean) : []);

/**
 * A plain-text description from the published job content (summary,
 * responsibilities, requirements, skills, benefits), falling back to the
 * legacy description. Never the hiring process notes or anything internal.
 */
export function buildPlainDescription(requisition) {
    const content = requisition?.jobContent && typeof requisition.jobContent === "object" ? requisition.jobContent : null;
    const parts = [];
    if (content) {
        if (String(content.summary ?? "").trim()) parts.push(String(content.summary).trim());
        const section = (label, items) => {
            const list = listOf(items);
            if (list.length) parts.push(`${label}:\n${list.map((item) => `- ${item}`).join("\n")}`);
        };
        section("Responsibilities", content.responsibilities);
        section("Requirements", content.requirements);
        section("Skills", content.skills);
        section("Benefits", content.benefits);
    }
    if (!parts.length && String(requisition?.description ?? "").trim()) parts.push(String(requisition.description).trim());
    return parts.join("\n\n") || null;
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** One requisition as the employee sees it on the board. */
export function toBoardJob(requisition, { applied = false } = {}) {
    const postings = requisition?.postings ?? [];
    const firstPosted = postings.reduce(
        (earliest, p) => (p.postedAt && (!earliest || new Date(p.postedAt) < earliest) ? new Date(p.postedAt) : earliest),
        null,
    );
    return {
        id: requisition.id,
        title: requisition.title,
        // JobRequisition.departmentId points at an RBAC-owned department; the
        // board carries the id and the client resolves the name it already has.
        departmentId: requisition.departmentId ?? null,
        location: requisition.location ?? null,
        employmentType: requisition.employmentType ?? null,
        openings: requisition.openings ?? 1,
        postedAt: iso(firstPosted ?? requisition.publishedAt),
        closesAt: iso(requisition.closesAt),
        description: buildPlainDescription(requisition),
        applied: applied === true,
    };
}

/** The referrer's own view of a referral: status and bonus status only. */
export function toSelfReferral(row, { jobTitle = null } = {}) {
    return {
        id: row.id,
        requisitionId: row.requisitionId,
        jobTitle,
        relationship: row.relationship ?? null,
        status: row.status,
        bonusStatus: row.bonusStatus,
        submittedAt: iso(row.createdAt),
    };
}

/** HR's view of a referral; the bonus amount only for a compensation scope. */
export function toHrReferral(row, { jobTitle = null, canSeeCompensation = false } = {}) {
    return {
        id: row.id,
        requisitionId: row.requisitionId,
        jobTitle,
        referrerEmployeeId: row.referrerEmployeeId,
        candidateId: row.candidateId ?? null,
        applicationId: row.applicationId ?? null,
        relationship: row.relationship ?? null,
        note: row.note ?? null,
        status: row.status,
        hiredAt: iso(row.hiredAt),
        bonusStatus: row.bonusStatus,
        bonusEligibleAt: iso(row.bonusEligibleAt),
        bonusAmount: canSeeCompensation && row.bonusAmount != null ? String(row.bonusAmount) : null,
        bonusCurrency: canSeeCompensation ? row.bonusCurrency ?? null : null,
        ...(canSeeCompensation ? {} : { compensationRedacted: true }),
        bonusDecidedById: row.bonusDecidedById ?? null,
        bonusDecidedAt: iso(row.bonusDecidedAt),
        version: row.version,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
    };
}
