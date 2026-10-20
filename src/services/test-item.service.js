// src/services/test-item.service.js
//
// Recruitment Phase 3b — the TEST ITEM BANK: authoring, four-eyes review,
// versioning, retirement, AI drafting and the statistics read.
//
//   create     an author writes a DRAFT, version 1, authorId = the caller.
//   update     a DRAFT is edited in place by its author only (anyone else
//              would become a hidden co-author able to pass four eyes). A
//              PUBLISHED item is immutable: editing it creates version + 1 as
//              a DRAFT under the same itemCode, and the published version stays
//              live until the new one is published, which retires it. A
//              RETIRED item, or one IN_REVIEW, cannot be edited.
//   submit     DRAFT -> IN_REVIEW, only with a rationale.
//   decide     a reviewer who is NOT the item's author publishes it or returns
//              it with a comment (403 HR-RECRUITMENT-ASSESSMENT-FOUR-EYES; the
//              candidate_test_items_four_eyes_check CHECK backs this up). Four
//              eyes is per person: a recruiter can author and review, never
//              the same item.
//   retire     a reviewer or recruiter retires any non-retired version with a
//              reason.
//   draft_ai   the AI plane (hr.assessment.item.draft.v1) drafts items from a
//              requisition's skills; valid drafts land as aiDrafted DRAFTs that
//              need the same human review. AI never scores anything.
//
// Who sees what (capabilities from assessment-access.util.js):
//   * reviewers and recruiters: every item, with the answer key, per-option
//     feedback, rationale and review comment.
//   * authors: their own items in every status plus PUBLISHED ones; the key
//     only on their own items.
//   * hiring managers and interviewers: PUBLISHED items marked as discussion
//     prompts (the ones the test report shows), never a key, feedback or
//     rationale. Reception: nothing.
// Lists never carry the key. The key is C4-encrypted at rest (the prisma
// extension), selected only where this service needs it, and never logged.
//
// Everything is behind the onsiteTest flag (503 ...-ONSITE-TEST-DISABLED) and
// AI drafting also behind `ai`. Events are ids only.
import { Prisma } from "@prisma/client";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { assertAssessmentCapability } from "../lib/assessment-access.util.js";
import { runAiTask } from "../lib/aiPlaneClient.js";
import { normalizeJobFamily } from "../lib/test-blueprint.util.js";
import { resolveSkill } from "../lib/skillNormalization.js";
import {
    AI_DRAFT_MAX,
    AI_DRAFT_TYPES,
    ITEM_DIFFICULTIES,
    ITEM_LANGUAGES,
    ITEM_STATUS,
    assertTransition,
    decodeAnswerKey,
    itemCodeFor,
    normalizeCompetencyKey,
    normalizeItemInput,
    parseAiDraftItems,
    reviewReadinessErrors,
    sanitizeRichText,
} from "../lib/test-item.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { loadAliasIndex, requisitionSkillRequirements } from "./candidateMatch.service.js";

const log = logger.child({ component: "test-item" });

export const TEST_ITEM_EVENTS = Object.freeze({
    PUBLISHED: "hr.recruitment.test_item_published.v1",
    RETIRED: "hr.recruitment.test_item_retired.v1",
    FLAGGED: "hr.recruitment.test_item_flagged.v1",
});
export const TEST_ITEM_DRAFT_PROMPT_KEY = "hr.assessment.item.draft.v1";
export const REVIEW_DECISIONS = Object.freeze(["PUBLISH", "RETURN"]);

const MAX_PAGE_SIZE = 100;
const MAX_COMMENT = 2000;
const MAX_QUERY = 200;
const OPEN_STATUSES = Object.freeze([ITEM_STATUS.DRAFT, ITEM_STATUS.IN_REVIEW]);

// The fields an edit may change (itemCode, version, author and the counters
// are the server's).
const EDITABLE_FIELDS = Object.freeze([
    "type", "stem", "mediaId", "options", "answerKey", "scoringRule", "difficulty", "competencyKey", "skillId",
    "jobFamily", "gradeLevelIds", "language", "timeEstimateSec", "rationale", "discussionPrompt", "exposureCap",
]);

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const notFound = () => fail("Test item not found", 404, "HR-RECRUITMENT-TEST-ITEM-NOT-FOUND");

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/** 503 when the on-site test flag is off (every item bank entry point). */
export function assertOnsiteTestEnabled() {
    if (!isRecruitmentFlagEnabled("onsiteTest")) {
        throw fail("The on-site assessment is disabled", 503, "HR-RECRUITMENT-ONSITE-TEST-DISABLED");
    }
}

function requireTenant(tenantId) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
}

// Authoring and reviewing are per person (four eyes), so they need the
// caller's employee id.
function requireActor(access) {
    const id = positiveInt(access?.employeeId);
    if (!id) throw fail("An employee identity is required to author or review test items", 403, "HR-RECRUITMENT-ASSESSMENT-ACTOR-REQUIRED");
    return id;
}

// ── Events (ids only) ────────────────────────────────────────────────────────

/** One builder for the item events; null when the row has no tenant. */
export function testItemEvent(eventName, item, { actorId = null, ...extra } = {}) {
    if (!item?.tenantId) return null;
    return {
        eventName,
        tenantId: item.tenantId,
        aggregateType: "CandidateTestItem",
        aggregateId: item.id,
        actorId,
        payload: {
            itemId: String(item.id),
            itemCode: item.itemCode ?? null,
            version: item.version ?? null,
            ...extra,
        },
    };
}

// ── Reads and presentation ───────────────────────────────────────────────────

export const TEST_ITEM_SUMMARY_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    itemCode: true,
    version: true,
    status: true,
    type: true,
    stem: true,
    mediaId: true,
    options: true,
    difficulty: true,
    competencyKey: true,
    skillId: true,
    jobFamily: true,
    gradeLevelIds: true,
    language: true,
    timeEstimateSec: true,
    discussionPrompt: true,
    aiDrafted: true,
    authorId: true,
    reviewerId: true,
    submittedAt: true,
    publishedAt: true,
    retiredAt: true,
    exposureCount: true,
    exposureCap: true,
    createdAt: true,
    updatedAt: true,
});
// Detail adds the privileged text; answerKey is selected separately.
const DETAIL_SELECT = Object.freeze({ ...TEST_ITEM_SUMMARY_SELECT, scoringRule: true, rationale: true, reviewComment: true });

const isOwnItem = (access, item) => Boolean(access?.author && positiveInt(access.employeeId) && item?.authorId === positiveInt(access.employeeId));

/** May this caller see the item's key, feedback and rationale? */
export function canSeeAnswerKey(access, item) {
    return Boolean(access?.reviewer || access?.recruiter || isOwnItem(access, item));
}

/**
 * The where fragment for the items this caller may read, or null when the
 * caller may read none (reception, finance, agency).
 */
export function itemVisibilityWhere(access) {
    if (access?.reviewer || access?.recruiter) return {};
    if (access?.author) {
        const me = positiveInt(access.employeeId);
        return me ? { OR: [{ authorId: me }, { status: ITEM_STATUS.PUBLISHED }] } : { status: ITEM_STATUS.PUBLISHED };
    }
    if (access?.manager || access?.interviewer) return { status: ITEM_STATUS.PUBLISHED, discussionPrompt: true };
    return null;
}

function requireVisibility(access) {
    const where = itemVisibilityWhere(access);
    if (!where) throw fail("You are not allowed to read the item bank", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    return where;
}

/** A list row: never the key, never per-option feedback. */
export function presentTestItemSummary(row) {
    if (!row) return null;
    const { options, tenantId: _tenantId, ...rest } = row;
    return { ...rest, optionCount: Array.isArray(options) ? options.length : 0 };
}

/** A detail view for this caller; the key only when canSeeAnswerKey. */
export function presentTestItem(row, access, answerKeyText = undefined) {
    if (!row) return null;
    const { tenantId: _tenantId, answerKey: _stored, rationale, reviewComment, scoringRule, options, ...rest } = row;
    const privileged = canSeeAnswerKey(access, row);
    const shownOptions = Array.isArray(options)
        ? options.map((o) => (privileged ? { ...o } : { id: o.id, text: o.text }))
        : null;
    const view = { ...rest, options: shownOptions, scoringRule: scoringRule ?? null };
    if (!privileged) return view;
    return {
        ...view,
        answerKey: answerKeyText === undefined ? undefined : decodeAnswerKey(answerKeyText),
        rationale: rationale ?? null,
        reviewComment: reviewComment ?? null,
    };
}

async function loadItem(db, tenantId, itemId, { withKey = false, where = {} } = {}) {
    const id = positiveInt(itemId);
    if (!id) throw notFound();
    const row = await db.candidateTestItem.findFirst({
        where: withTenant(tenantId, { AND: [{ id }, where] }),
        select: withKey ? { ...DETAIL_SELECT, answerKey: true } : DETAIL_SELECT,
    });
    if (!row) throw notFound();
    return row;
}

// The stored row as editor input, for merging an edit and re-validating.
function rowAsInput(row) {
    return {
        type: row.type,
        stem: row.stem,
        mediaId: row.mediaId,
        options: row.options,
        answerKey: decodeAnswerKey(row.answerKey),
        scoringRule: row.scoringRule,
        difficulty: row.difficulty,
        competencyKey: row.competencyKey,
        skillId: row.skillId,
        jobFamily: row.jobFamily,
        gradeLevelIds: row.gradeLevelIds,
        language: row.language,
        timeEstimateSec: row.timeEstimateSec,
        rationale: row.rationale,
        discussionPrompt: row.discussionPrompt,
        exposureCap: row.exposureCap,
    };
}

function invalid(errors) {
    return fail("The test item is not valid", 400, "HR-RECRUITMENT-TEST-ITEM-INVALID", { errors });
}

function normalizeOrThrow(input) {
    const result = normalizeItemInput(input);
    if (!result.ok) throw invalid(result.errors);
    return result.value;
}

// ── Taxonomy links (skill, grade levels) ─────────────────────────────────────

/**
 * Check the skill and grade level ids of a batch of normalised items against
 * the tenant's taxonomy, and link a competency to its Skill when no skillId
 * was given (exact alias match only, see skillNormalization.js).
 * @returns {Promise<Array<Array<{ field: string, message: string }>>>} errors per item (mutates skillId)
 */
export async function linkTaxonomy(db, tenantId, values) {
    const errors = values.map(() => []);
    const skillIds = [...new Set(values.map((v) => v.skillId).filter(Boolean))];
    const gradeIds = [...new Set(values.flatMap((v) => v.gradeLevelIds ?? []))];
    const [skills, grades] = await Promise.all([
        skillIds.length
            ? db.skill.findMany({ where: { id: { in: skillIds }, OR: [{ tenantId: null }, { tenantId }] }, select: { id: true } })
            : [],
        gradeIds.length ? db.gradeLevel.findMany({ where: withTenant(tenantId, { id: { in: gradeIds } }), select: { id: true } }) : [],
    ]);
    const knownSkills = new Set(skills.map((s) => s.id));
    const knownGrades = new Set(grades.map((g) => g.id));
    let index = null;
    for (const [i, value] of values.entries()) {
        if (value.skillId && !knownSkills.has(value.skillId)) errors[i].push({ field: "skillId", message: `Skill ${value.skillId} does not exist` });
        const missing = (value.gradeLevelIds ?? []).filter((id) => !knownGrades.has(id));
        if (missing.length) errors[i].push({ field: "gradeLevelIds", message: `Grade levels not found: ${missing.join(", ")}` });
        if (!value.skillId) {
            if (!index) index = await loadAliasIndex(tenantId);
            const hit = resolveSkill(index, value.competencyKey).skillId ?? resolveSkill(index, value.competencyKey.replace(/[-_.:]+/g, " ")).skillId;
            value.skillId = hit ?? null;
        }
    }
    return errors;
}

async function linkTaxonomyOrThrow(db, tenantId, value) {
    const [errors] = await linkTaxonomy(db, tenantId, [value]);
    if (errors.length) throw invalid(errors);
}

// ── Writes ───────────────────────────────────────────────────────────────────

const jsonOrNull = (value, forUpdate) => (value === null || value === undefined ? (forUpdate ? Prisma.DbNull : undefined) : value);

// The content columns of a normalised item (create and in-place update).
function contentData(value, { forUpdate = false } = {}) {
    return {
        type: value.type,
        stem: value.stem,
        mediaId: value.mediaId,
        options: jsonOrNull(value.options, forUpdate),
        answerKey: JSON.stringify(value.answerKey),
        scoringRule: jsonOrNull(value.scoringRule, forUpdate),
        difficulty: value.difficulty,
        competencyKey: value.competencyKey,
        skillId: value.skillId ?? null,
        jobFamily: value.jobFamily,
        gradeLevelIds: value.gradeLevelIds,
        language: value.language,
        timeEstimateSec: value.timeEstimateSec,
        rationale: value.rationale,
        discussionPrompt: value.discussionPrompt,
        exposureCap: value.exposureCap,
    };
}

/** The itemCode for a new item: the author's, or derived from the content. */
export const codeForNewItem = (value) => value.itemCode ?? itemCodeFor(value);

/** Codes (any version) the tenant already uses, out of `codes`. */
export async function findTakenCodes(db, tenantId, codes) {
    if (!codes.length) return new Set();
    const rows = await db.candidateTestItem.findMany({
        where: withTenant(tenantId, { itemCode: { in: codes } }),
        select: { itemCode: true },
    });
    return new Set(rows.map((r) => r.itemCode));
}

const duplicate = (itemCode) =>
    fail(`An item with code ${itemCode} already exists`, 409, "HR-RECRUITMENT-TEST-ITEM-DUPLICATE", { itemCode });

const isUniqueViolation = (err) => err?.code === "P2002";

/**
 * Insert new DRAFT version-1 items in an open transaction. Each value is
 * normalised and linked; `itemCode` is already decided.
 */
export async function insertDraftItems(tx, tenantId, entries, { authorId, aiDrafted = false }) {
    const rows = [];
    for (const { value, itemCode } of entries) {
        rows.push(
            await tx.candidateTestItem.create({
                data: {
                    tenantId,
                    itemCode,
                    version: 1,
                    status: ITEM_STATUS.DRAFT,
                    ...contentData(value),
                    aiDrafted,
                    authorId,
                },
                select: TEST_ITEM_SUMMARY_SELECT,
            }),
        );
    }
    return rows;
}

// ── List and get ─────────────────────────────────────────────────────────────

/** List items the caller may read; never the key. */
export async function listTestItems({
    tenantId, access, status, competencyKey, jobFamily, difficulty, language, type, q, page = 1, limit = 50,
} = {}) {
    assertOnsiteTestEnabled();
    requireTenant(tenantId);
    const visible = requireVisibility(access);
    const filters = [visible];
    if (status) filters.push({ status: String(status).toUpperCase() });
    if (competencyKey) filters.push({ competencyKey: normalizeCompetencyKey(competencyKey) });
    if (jobFamily) filters.push({ jobFamily: normalizeJobFamily(jobFamily) });
    if (difficulty) filters.push({ difficulty: String(difficulty).toUpperCase() });
    if (language) filters.push({ language: String(language).toLowerCase() });
    if (type) filters.push({ type: String(type).toUpperCase() });
    const text = String(q ?? "").trim().slice(0, MAX_QUERY);
    if (text) {
        filters.push({ OR: [{ stem: { contains: text, mode: "insensitive" } }, { itemCode: { contains: text.toUpperCase() } }] });
    }
    const where = withTenant(tenantId, { AND: filters });
    const take = Math.min(Math.max(Number(limit) || 50, 1), MAX_PAGE_SIZE);
    const pageNo = Math.max(Number(page) || 1, 1);
    const [rows, total] = await Promise.all([
        prisma.candidateTestItem.findMany({
            where,
            select: TEST_ITEM_SUMMARY_SELECT,
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            skip: (pageNo - 1) * take,
            take,
        }),
        prisma.candidateTestItem.count({ where }),
    ]);
    return { items: rows.map(presentTestItemSummary), total, page: pageNo, limit: take };
}

/** One item; the key, feedback and rationale only for privileged callers. */
export async function getTestItem({ tenantId, access, itemId } = {}) {
    assertOnsiteTestEnabled();
    requireTenant(tenantId);
    const visible = requireVisibility(access);
    const row = await loadItem(prisma, tenantId, itemId, { where: visible });
    if (!canSeeAnswerKey(access, row)) return presentTestItem(row, access);
    // Second read for the key: only once the caller is known to be entitled.
    const keyed = await loadItem(prisma, tenantId, row.id, { withKey: true });
    return presentTestItem(keyed, access, keyed.answerKey);
}

// ── Create and update ────────────────────────────────────────────────────────

/** A new DRAFT, version 1, authored by the caller. */
export async function createTestItem({ tenantId, access, input = {} } = {}) {
    assertOnsiteTestEnabled();
    requireTenant(tenantId);
    assertAssessmentCapability(access, "author", "Only assessment authors can write test items");
    const authorId = requireActor(access);
    const value = normalizeOrThrow(input);
    await linkTaxonomyOrThrow(prisma, tenantId, value);
    const itemCode = codeForNewItem(value);
    if ((await findTakenCodes(prisma, tenantId, [itemCode])).size) throw duplicate(itemCode);
    try {
        const [row] = await tenantTransaction(
            prisma,
            async (tx) => await insertDraftItems(tx, tenantId, [{ value, itemCode }], { authorId }),
            { tenantId },
        );
        return await getTestItem({ tenantId, access, itemId: row.id });
    } catch (err) {
        if (isUniqueViolation(err)) throw duplicate(itemCode);
        throw err;
    }
}

function mergeEdit(row, patch) {
    const merged = rowAsInput(row);
    for (const field of EDITABLE_FIELDS) {
        if (patch[field] !== undefined) merged[field] = patch[field];
    }
    // A new competency is linked to its skill again unless one is given.
    if (patch.competencyKey !== undefined && patch.skillId === undefined) merged.skillId = null;
    return merged;
}

async function editDraftInPlace({ tenantId, access, row, patch }) {
    // Only the author edits a draft in place: an edit by anyone else would make
    // them a hidden co-author who could then pass four eyes as its reviewer.
    // A reviewer returns the draft with comments instead.
    if (!isOwnItem(access, row)) {
        throw fail("Only the item's author can edit this draft; return it with comments instead", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    }
    const value = normalizeOrThrow(mergeEdit(row, patch));
    await linkTaxonomyOrThrow(prisma, tenantId, value);
    const { count } = await tenantTransaction(
        prisma,
        async (tx) =>
            await tx.candidateTestItem.updateMany({
                where: withTenant(tenantId, { id: row.id, status: ITEM_STATUS.DRAFT }),
                data: contentData(value, { forUpdate: true }),
            }),
        { tenantId },
    );
    if (!count) throw fail("The item changed while you were editing it; reload and try again", 409, "HR-RECRUITMENT-TEST-ITEM-STATE");
    return { ...(await getTestItem({ tenantId, access, itemId: row.id })), createdVersion: false };
}

async function createNextVersion({ tenantId, access, row, patch }) {
    const authorId = requireActor(access);
    const value = normalizeOrThrow(mergeEdit(row, patch));
    await linkTaxonomyOrThrow(prisma, tenantId, value);
    const open = await prisma.candidateTestItem.findFirst({
        where: withTenant(tenantId, { itemCode: row.itemCode, status: { in: [...OPEN_STATUSES] } }),
        select: { id: true, version: true, status: true },
    });
    if (open) {
        throw fail(`Version ${open.version} of this item is already ${open.status}; edit that version instead`, 409, "HR-RECRUITMENT-TEST-ITEM-VERSION-OPEN", { itemId: open.id });
    }
    const latest = await prisma.candidateTestItem.findFirst({
        where: withTenant(tenantId, { itemCode: row.itemCode }),
        select: { version: true },
        orderBy: { version: "desc" },
    });
    try {
        const created = await tenantTransaction(
            prisma,
            async (tx) =>
                await tx.candidateTestItem.create({
                    data: {
                        tenantId,
                        itemCode: row.itemCode,
                        version: (latest?.version ?? row.version) + 1,
                        status: ITEM_STATUS.DRAFT,
                        ...contentData(value),
                        authorId,
                    },
                    select: { id: true },
                }),
            { tenantId },
        );
        return { ...(await getTestItem({ tenantId, access, itemId: created.id })), createdVersion: true, previousItemId: row.id };
    } catch (err) {
        if (isUniqueViolation(err)) throw fail("Another new version of this item was just created; reload", 409, "HR-RECRUITMENT-TEST-ITEM-VERSION-OPEN");
        throw err;
    }
}

/**
 * Edit an item. A DRAFT changes in place; a PUBLISHED item gets a new DRAFT
 * version (the published one stays live); IN_REVIEW and RETIRED are refused.
 */
export async function updateTestItem({ tenantId, access, itemId, patch = {} } = {}) {
    assertOnsiteTestEnabled();
    requireTenant(tenantId);
    assertAssessmentCapability(access, "author", "Only assessment authors can edit test items");
    const row = await loadItem(prisma, tenantId, itemId, { withKey: true, where: requireVisibility(access) });
    if (row.status === ITEM_STATUS.RETIRED) throw fail("A retired item cannot be edited", 409, "HR-RECRUITMENT-TEST-ITEM-RETIRED");
    if (row.status === ITEM_STATUS.IN_REVIEW) {
        throw fail("The item is in review; the reviewer must return it before it can be edited", 409, "HR-RECRUITMENT-TEST-ITEM-IN-REVIEW");
    }
    if (row.status === ITEM_STATUS.PUBLISHED) return createNextVersion({ tenantId, access, row, patch });
    return editDraftInPlace({ tenantId, access, row, patch });
}

// ── Review lifecycle ─────────────────────────────────────────────────────────

/** DRAFT -> IN_REVIEW; the item must be complete, rationale included. */
export async function submitTestItemForReview({ tenantId, access, itemId, now = new Date() } = {}) {
    assertOnsiteTestEnabled();
    requireTenant(tenantId);
    assertAssessmentCapability(access, "author", "Only assessment authors can submit test items");
    const row = await loadItem(prisma, tenantId, itemId, { withKey: true, where: requireVisibility(access) });
    assertTransition(row.status, ITEM_STATUS.IN_REVIEW);
    if (!isOwnItem(access, row) && !access?.recruiter) {
        throw fail("Only the item's author or a recruiter can submit it for review", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    }
    const check = normalizeItemInput(rowAsInput(row));
    const errors = [...check.errors, ...reviewReadinessErrors(row)];
    if (errors.length) throw invalid(errors);
    const { count } = await tenantTransaction(
        prisma,
        async (tx) =>
            await tx.candidateTestItem.updateMany({
                where: withTenant(tenantId, { id: row.id, status: ITEM_STATUS.DRAFT }),
                data: { status: ITEM_STATUS.IN_REVIEW, submittedAt: new Date(now) },
            }),
        { tenantId },
    );
    if (!count) throw fail("The item is no longer a draft", 409, "HR-RECRUITMENT-TEST-ITEM-STATE");
    return getTestItem({ tenantId, access, itemId: row.id });
}

function normalizeComment(comment, required) {
    const text = String(comment ?? "").trim();
    if (required && !text) throw fail("A comment is required when returning an item", 400, "HR-RECRUITMENT-TEST-ITEM-COMMENT-REQUIRED");
    if (text.length > MAX_COMMENT) throw fail(`The comment must be at most ${MAX_COMMENT} characters`, 400, "HR-RECRUITMENT-TEST-ITEM-COMMENT-REQUIRED");
    return text || null;
}

async function publishInTransaction(tx, { tenantId, row, reviewerId, comment, at }) {
    const { count } = await tx.candidateTestItem.updateMany({
        where: withTenant(tenantId, { id: row.id, status: ITEM_STATUS.IN_REVIEW }),
        data: { status: ITEM_STATUS.PUBLISHED, reviewerId, reviewComment: comment, publishedAt: at },
    });
    if (!count) throw fail("The item is no longer in review", 409, "HR-RECRUITMENT-TEST-ITEM-STATE");
    await enqueueHrDomainEvent(tx, testItemEvent(TEST_ITEM_EVENTS.PUBLISHED, row, { actorId: reviewerId }));
    // The version it replaces stops being drawn from now on.
    const superseded = await tx.candidateTestItem.findMany({
        where: withTenant(tenantId, { itemCode: row.itemCode, status: ITEM_STATUS.PUBLISHED, id: { not: row.id } }),
        select: { id: true, tenantId: true, itemCode: true, version: true },
    });
    for (const old of superseded) {
        const done = await tx.candidateTestItem.updateMany({
            where: withTenant(tenantId, { id: old.id, status: ITEM_STATUS.PUBLISHED }),
            data: { status: ITEM_STATUS.RETIRED, retiredAt: at },
        });
        if (done.count) {
            await enqueueHrDomainEvent(tx, testItemEvent(TEST_ITEM_EVENTS.RETIRED, old, {
                actorId: reviewerId,
                reasonCode: "SUPERSEDED",
                supersededByItemId: String(row.id),
            }));
        }
    }
    return superseded.map((s) => s.id);
}

/**
 * A reviewer publishes an IN_REVIEW item or returns it to DRAFT with a
 * comment. Never the item's own author.
 */
export async function decideTestItemReview({ tenantId, access, itemId, decision, comment, now = new Date() } = {}) {
    assertOnsiteTestEnabled();
    requireTenant(tenantId);
    assertAssessmentCapability(access, "reviewer", "Only assessment reviewers can publish or return test items");
    const reviewerId = requireActor(access);
    const verdict = String(decision ?? "").trim().toUpperCase();
    if (!REVIEW_DECISIONS.includes(verdict)) throw fail("decision must be PUBLISH or RETURN", 400, "HR-RECRUITMENT-TEST-ITEM-DECISION-INVALID");
    const row = await loadItem(prisma, tenantId, itemId);
    if (row.authorId != null && row.authorId === reviewerId) {
        throw fail("You cannot review an item you wrote", 403, "HR-RECRUITMENT-ASSESSMENT-FOUR-EYES");
    }
    const at = new Date(now);
    const text = normalizeComment(comment, verdict === "RETURN");
    if (verdict === "RETURN") {
        assertTransition(row.status, ITEM_STATUS.DRAFT);
        const { count } = await tenantTransaction(
            prisma,
            async (tx) =>
                await tx.candidateTestItem.updateMany({
                    where: withTenant(tenantId, { id: row.id, status: ITEM_STATUS.IN_REVIEW }),
                    data: { status: ITEM_STATUS.DRAFT, reviewerId, reviewComment: text },
                }),
            { tenantId },
        );
        if (!count) throw fail("The item is no longer in review", 409, "HR-RECRUITMENT-TEST-ITEM-STATE");
        return { ...(await getTestItem({ tenantId, access, itemId: row.id })), retiredItemIds: [] };
    }
    assertTransition(row.status, ITEM_STATUS.PUBLISHED);
    const retiredItemIds = await tenantTransaction(
        prisma,
        async (tx) => await publishInTransaction(tx, { tenantId, row, reviewerId, comment: text, at }),
        { tenantId },
    );
    log.info({ itemId: row.id, version: row.version, retiredItemIds }, "test item published");
    return { ...(await getTestItem({ tenantId, access, itemId: row.id })), retiredItemIds };
}

/** Retire any non-retired version with a reason (reviewer or recruiter). */
export async function retireTestItem({ tenantId, access, itemId, reason, now = new Date() } = {}) {
    assertOnsiteTestEnabled();
    requireTenant(tenantId);
    if (!access?.reviewer && !access?.recruiter) {
        throw fail("Only assessment reviewers and recruiters can retire test items", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    }
    const why = sanitizeRichText(reason).replace(/<[^>]*>/g, "").trim();
    if (!why) throw fail("A reason is required to retire an item", 400, "HR-RECRUITMENT-TEST-ITEM-REASON-REQUIRED");
    if (why.length > MAX_COMMENT) throw fail(`The reason must be at most ${MAX_COMMENT} characters`, 400, "HR-RECRUITMENT-TEST-ITEM-REASON-REQUIRED");
    const row = await loadItem(prisma, tenantId, itemId);
    assertTransition(row.status, ITEM_STATUS.RETIRED);
    const actorId = positiveInt(access.employeeId);
    await tenantTransaction(
        prisma,
        async (tx) => {
            const { count } = await tx.candidateTestItem.updateMany({
                where: withTenant(tenantId, { id: row.id, status: row.status }),
                data: { status: ITEM_STATUS.RETIRED, retiredAt: new Date(now), reviewComment: `Retired: ${why}` },
            });
            if (!count) throw fail("The item changed; reload and try again", 409, "HR-RECRUITMENT-TEST-ITEM-STATE");
            await enqueueHrDomainEvent(tx, testItemEvent(TEST_ITEM_EVENTS.RETIRED, row, {
                actorId,
                reasonCode: "MANUAL",
                previousStatus: row.status,
            }));
        },
        { tenantId },
    );
    return getTestItem({ tenantId, access, itemId: row.id });
}

// ── Statistics read ──────────────────────────────────────────────────────────

/** The latest nightly statistics rows and flags for one item version. */
export async function getTestItemStats({ tenantId, access, itemId, limit = 10 } = {}) {
    assertOnsiteTestEnabled();
    requireTenant(tenantId);
    if (!access?.reviewer && !access?.recruiter) {
        throw fail("Only assessment reviewers and recruiters can read item statistics", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    }
    const row = await loadItem(prisma, tenantId, itemId);
    const take = Math.min(Math.max(Number(limit) || 10, 1), 90);
    const history = await prisma.candidateTestItemStat.findMany({
        where: withTenant(tenantId, { itemId: row.id }),
        select: { period: true, sampleSize: true, difficulty: true, discrimination: true, distractorRates: true, avgTimeSec: true, flags: true, computedAt: true },
        orderBy: { period: "desc" },
        take,
    });
    return {
        itemId: row.id,
        itemCode: row.itemCode,
        version: row.version,
        status: row.status,
        exposureCount: row.exposureCount,
        exposureCap: row.exposureCap,
        latest: history[0] ?? null,
        flags: history[0]?.flags ?? [],
        history,
    };
}

// ── AI drafting ──────────────────────────────────────────────────────────────

const aiUnavailable = (message, details) => fail(message, 503, "HR-RECRUITMENT-AI-UNAVAILABLE", details);

// The requisition's job content, read for its skills only. Authors may have
// no recruitment row scope (ASSESSMENT), so this reads the tenant's
// requisition directly and returns nothing but the title and skill names.
async function requisitionSkills(tenantId, requisitionId) {
    const id = positiveInt(requisitionId);
    if (!id) throw fail("Requisition not found", 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
    const requisition = await prisma.jobRequisition.findFirst({
        where: withTenant(tenantId, { id }),
        select: { id: true, title: true, jobContent: true, requirements: true },
    });
    if (!requisition) throw fail("Requisition not found", 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
    const skills = requisitionSkillRequirements(requisition) ?? { required: [], preferred: [] };
    const summary = typeof requisition.jobContent?.summary === "string" ? requisition.jobContent.summary.slice(0, 2000) : null;
    return { title: requisition.title ?? null, summary, required: skills.required ?? [], preferred: skills.preferred ?? [] };
}

function draftRequest({ competencyKeys, skills, count, difficulty, language, types }) {
    const n = Number(count ?? 5);
    if (!Number.isInteger(n) || n < 1 || n > AI_DRAFT_MAX) throw fail(`count must be from 1 to ${AI_DRAFT_MAX}`, 400, "HR-RECRUITMENT-TEST-ITEM-DRAFT-INVALID");
    const level = String(difficulty ?? "MEDIUM").toUpperCase();
    if (!ITEM_DIFFICULTIES.includes(level)) throw fail(`difficulty must be one of ${ITEM_DIFFICULTIES.join(", ")}`, 400, "HR-RECRUITMENT-TEST-ITEM-DRAFT-INVALID");
    const lang = String(language ?? "en").toLowerCase();
    if (!ITEM_LANGUAGES.includes(lang)) throw fail(`language must be one of ${ITEM_LANGUAGES.join(", ")}`, 400, "HR-RECRUITMENT-TEST-ITEM-DRAFT-INVALID");
    const kinds = [...new Set((types?.length ? types : ["SINGLE"]).map((t) => String(t).toUpperCase()))];
    if (kinds.some((t) => !AI_DRAFT_TYPES.includes(t))) throw fail(`types must be among ${AI_DRAFT_TYPES.join(", ")}`, 400, "HR-RECRUITMENT-TEST-ITEM-DRAFT-INVALID");
    const fromCaller = (Array.isArray(competencyKeys) ? competencyKeys : []).map(normalizeCompetencyKey).filter(Boolean);
    const fromSkills = [...skills.required, ...skills.preferred].map(normalizeCompetencyKey).filter(Boolean);
    const competencies = [...new Set(fromCaller.length ? fromCaller : fromSkills)].slice(0, 20);
    if (!competencies.length) {
        throw fail("Name the competencies to draft for, or a requisition with skills", 400, "HR-RECRUITMENT-TEST-ITEM-DRAFT-INVALID");
    }
    return { count: n, difficulty: level, language: lang, types: kinds, competencies };
}

async function callDraftPlane({ tenantId, request, job }) {
    let res;
    try {
        res = await runAiTask({
            promptKey: TEST_ITEM_DRAFT_PROMPT_KEY,
            type: "hr.assessment.item_draft",
            tenantId,
            input: {
                count: request.count,
                difficulty: request.difficulty,
                language: request.language,
                itemTypes: request.types,
                competencies: request.competencies,
                job,
                format: "JSON { items: [{ type, competencyKey, stem, options: [{ id, text, feedback }], correctOptionIds, value, tolerance, rationale, timeEstimateSec }] }",
                constraints: { minOptions: 2, maxOptions: 6, trueFalseOptionIds: ["true", "false"], numericHasNoOptions: true },
            },
        });
    } catch (err) {
        log.warn({ code: err?.code, tenantId }, "test item draft: AI plane unavailable");
        throw aiUnavailable("The AI drafting service is unavailable; try again later or write the items by hand");
    }
    if (res?.pending) throw aiUnavailable("The AI drafting service did not answer in time; try again later", { taskId: res.taskId });
    const status = String(res?.status ?? "").toLowerCase();
    if (res?.error || status === "error" || status === "failed") {
        throw aiUnavailable("The AI drafting service could not draft items; try again later", { taskId: res?.taskId ?? null });
    }
    return res;
}

/**
 * Ask the AI plane for item drafts from a requisition's skills (or named
 * competencies) and store the valid ones as aiDrafted DRAFTs authored by the
 * caller. Invalid or duplicate drafts are reported, not stored.
 */
export async function draftTestItemsWithAi({
    tenantId, access, requisitionId = null, competencyKeys, count, difficulty, language, types,
} = {}) {
    assertOnsiteTestEnabled();
    if (!isRecruitmentFlagEnabled("ai")) throw fail("AI features are disabled", 503, "HR-RECRUITMENT-AI-DISABLED");
    requireTenant(tenantId);
    assertAssessmentCapability(access, "author", "Only assessment authors can request AI drafts");
    const authorId = requireActor(access);
    const job = requisitionId != null ? await requisitionSkills(tenantId, requisitionId) : { title: null, summary: null, required: [], preferred: [] };
    const request = draftRequest({ competencyKeys, skills: job, count, difficulty, language, types });

    const res = await callDraftPlane({ tenantId, request, job });
    const parsed = parseAiDraftItems(res.output, request);
    if (!parsed.ok) throw fail(parsed.reason, 502, "HR-RECRUITMENT-AI-OUTPUT-INVALID", { taskId: res.taskId ?? null });

    const dropped = [...parsed.dropped];
    const linkErrors = await linkTaxonomy(prisma, tenantId, parsed.drafts);
    const candidates = [];
    parsed.drafts.forEach((value, i) => {
        if (linkErrors[i].length) dropped.push({ index: null, reason: linkErrors[i].map((e) => e.message).join("; ") });
        else candidates.push({ value, itemCode: codeForNewItem(value) });
    });
    const taken = await findTakenCodes(prisma, tenantId, candidates.map((c) => c.itemCode));
    const seen = new Set();
    const entries = candidates.filter((c) => {
        if (taken.has(c.itemCode) || seen.has(c.itemCode)) {
            dropped.push({ index: null, reason: `Duplicate of existing item ${c.itemCode}` });
            return false;
        }
        seen.add(c.itemCode);
        return true;
    });
    const rows = entries.length
        ? await tenantTransaction(prisma, async (tx) => await insertDraftItems(tx, tenantId, entries, { authorId, aiDrafted: true }), { tenantId })
        : [];
    log.info({ tenantId, requested: request.count, created: rows.length, dropped: dropped.length }, "test item AI drafts stored");
    return { taskId: res.taskId ?? null, created: rows.map(presentTestItemSummary), dropped };
}

export default {
    listTestItems,
    getTestItem,
    createTestItem,
    updateTestItem,
    submitTestItemForReview,
    decideTestItemReview,
    retireTestItem,
    getTestItemStats,
    draftTestItemsWithAi,
};
