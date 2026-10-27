// src/services/test-blueprint.service.js
//
// Recruitment Phase 3b (plan 7.3.3) — job-specific TEST BLUEPRINTS: how the
// on-arrival test for a role is assembled, who approves it, when it may be
// published, which requisitions it applies to, and the scheduling hook that
// marks an on-site interview as assessment-required. Flag onsiteTest; every
// entry point refuses with 503 HR-RECRUITMENT-ONSITE-TEST-DISABLED when off
// (the scheduling hook is a silent no-op instead, so scheduling never breaks).
//
//   create / update   authors and recruiters. A new blueprint is DRAFT. A
//                     PUBLISHED blueprint is immutable: updating it creates
//                     version + 1 as a DRAFT under the same blueprintKey. Any
//                     edit of an unpublished version clears both approvals
//                     and returns it to DRAFT.
//   approve           dual approval, two different people:
//                       HR             a recruiter or HR admin;
//                       HIRING_MANAGER the caller's employee id is the
//                                      requestedById of a requisition that
//                                      is either actively linked (REQUISITION
//                                      scope) to any version of this
//                                      blueprintKey, or in the blueprint's
//                                      job family. That is "the hiring
//                                      manager of a role this test is for",
//                                      checkable before the first publish.
//                     The first approval moves DRAFT to IN_APPROVAL, the
//                     second to APPROVED.
//   publish           reviewers and recruiters, APPROVED only, and only when
//                     every section's published pool is at least three times
//                     its draw per difficulty (409
//                     HR-RECRUITMENT-BLUEPRINT-POOL-SHALLOW with the report).
//                     The pool is PUBLISHED items in the blueprint's language
//                     and section competency whose job family is the
//                     blueprint's or null (a generic item fits any family; a
//                     blueprint with no family draws generic items only),
//                     counted by distinct itemCode. Publishing retires the
//                     key's previous published version and moves its active
//                     links to the new one, in one transaction.
//   link              one active link per scope (the partial unique index):
//                     linking deactivates the scope's previous link. A
//                     REQUISITION link may be made by a recruiter or by the
//                     requisition's own hiring manager; family links by
//                     recruiters. A blueprint that is not yet published may
//                     only take a scope that has no working (published) test,
//                     so a draft never silently switches a live test off.
//   resolve           REQUISITION, then JOB_FAMILY_GRADE, then JOB_FAMILY
//                     (lib/test-blueprint.util.js pickBlueprintLink).
//   preview           a sample draw, stems and options only: never the key,
//                     rationale, scoring rule or author feedback, and it never
//                     touches exposureCount.
//
// Visibility: authors, reviewers and recruiters see every blueprint (they are
// configuration, not candidate data); a hiring manager sees the blueprints
// linked to their requisitions or in their requisitions' job families;
// interviewers and reception see none.
//
// Items are read here directly with prisma (the item services belong to the
// item bank stream); answerKey is never selected in this file.
import { randomBytes, randomInt } from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { requisitionScopeWhere } from "../lib/recruitment-access.util.js";
import { assertAssessmentCapability } from "../lib/assessment-access.util.js";
import {
    BLUEPRINT_EDITABLE_FIELDS,
    BLUEPRINT_SCOPES,
    BLUEPRINT_STATUS,
    DIFFICULTIES,
    assessmentRequirementFor,
    drawPlan,
    isOnsiteInterview,
    normalizeBlueprintInput,
    normalizeJobFamily,
    pickBlueprintLink,
    poolDepthReport,
    requisitionJobFamily,
} from "../lib/test-blueprint.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

export const TEST_BLUEPRINT_EVENTS = Object.freeze({
    PUBLISHED: "hr.recruitment.test_blueprint_published.v1",
    INTERVIEW_ASSESSMENT_REQUIRED: "hr.recruitment.interview_assessment_required.v1",
});
export const APPROVAL_ROLES = Object.freeze(["HIRING_MANAGER", "HR"]);

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const UNPUBLISHED = [BLUEPRINT_STATUS.DRAFT, BLUEPRINT_STATUS.IN_APPROVAL, BLUEPRINT_STATUS.APPROVED];
const MAX_MANAGER_REQUISITIONS = 1000;

const fail = (message, status, code, extra = {}) =>
    Object.assign(new Error(message), { status, code, details: { code, ...extra } });

function assertEnabled() {
    if (!isRecruitmentFlagEnabled("onsiteTest")) {
        throw fail("The on-site test is not enabled", 503, "HR-RECRUITMENT-ONSITE-TEST-DISABLED");
    }
}

function requireTenant(tenantId) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
}

const toId = (value, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw fail(`${label} must be a positive integer`, 400, "HR-RECRUITMENT-BLUEPRINT-INVALID");
    return n;
};

const notFound = () => fail("Test blueprint not found", 404, "HR-RECRUITMENT-BLUEPRINT-NOT-FOUND");
const conflict = () => fail("The blueprint changed meanwhile; reload and try again", 409, "HR-RECRUITMENT-BLUEPRINT-CONFLICT");
const configAccess = (access) => access?.author || access?.reviewer || access?.recruiter;

// ── Events (ids only) ────────────────────────────────────────────────────────

export function testBlueprintPublishedEvent(blueprint, { actorId = null, retiredBlueprintIds = [], movedLinkCount = 0 } = {}) {
    if (!blueprint?.tenantId) return null;
    return {
        eventName: TEST_BLUEPRINT_EVENTS.PUBLISHED,
        tenantId: blueprint.tenantId,
        aggregateType: "CandidateTestBlueprint",
        aggregateId: blueprint.id,
        actorId,
        payload: {
            blueprintId: String(blueprint.id),
            blueprintKey: blueprint.blueprintKey,
            version: blueprint.version,
            retiredBlueprintIds: retiredBlueprintIds.map(String),
            movedLinkCount,
        },
    };
}

export function interviewAssessmentRequiredEvent({ tenantId, interviewId, applicationId, candidateId, requisitionId, blueprint, matchedScope, requirement }) {
    if (!tenantId) return null;
    const str = (v) => (v == null ? null : String(v));
    return {
        eventName: TEST_BLUEPRINT_EVENTS.INTERVIEW_ASSESSMENT_REQUIRED,
        tenantId,
        aggregateType: "Interview",
        aggregateId: interviewId,
        actorId: null,
        payload: {
            interviewId: str(interviewId),
            applicationId: str(applicationId),
            candidateId: str(candidateId),
            requisitionId: str(requisitionId),
            blueprintId: str(blueprint.id),
            blueprintVersion: blueprint.version,
            matchedScope,
            assessmentStatus: requirement.assessmentStatus,
            reused: requirement.reusedResultId != null,
            reusedResultId: str(requirement.reusedResultId),
            cooldownActive: requirement.cooldownActive,
            cooldownResultId: str(requirement.cooldownResultId),
        },
    };
}

// ── Reads shared by the tools and the hooks ──────────────────────────────────

const REQUISITION_SELECT = Object.freeze({
    id: true,
    title: true,
    requestedById: true,
    gradeLevelId: true,
    jobContent: true,
    position: { select: { jobCode: true } },
});

function presentBlueprint(row) {
    if (!row) return row;
    const { links, ...rest } = row;
    return {
        ...rest,
        approvals: {
            hiringManager: row.approvedByHiringManagerId != null ? { employeeId: row.approvedByHiringManagerId, at: row.hiringManagerApprovedAt } : null,
            hr: row.approvedByHrId != null ? { employeeId: row.approvedByHrId, at: row.hrApprovedAt } : null,
        },
        ...(links ? { links: links.map(presentLink) } : {}),
    };
}

const presentLink = (l) => ({ id: l.id, blueprintId: l.blueprintId, scopeType: l.scopeType, scopeId: l.scopeId, scopeKey: l.scopeKey, isActive: l.isActive, createdAt: l.createdAt });

async function loadBlueprint(db, tenantId, id) {
    const row = await db.candidateTestBlueprint.findFirst({ where: withTenant(tenantId, { id }) });
    if (!row) throw notFound();
    return row;
}

/** A manager's requisitions (requested or approved), with their families. */
async function managerRequisitions(db, tenantId, scope) {
    const rows = await db.jobRequisition.findMany({
        where: withTenant(tenantId, requisitionScopeWhere(scope)),
        select: REQUISITION_SELECT,
        take: MAX_MANAGER_REQUISITIONS,
    });
    return rows.map((r) => ({ ...r, jobFamily: requisitionJobFamily(r) }));
}

function managerVisibilityWhere(requisitions) {
    const ids = requisitions.map((r) => r.id);
    const families = [...new Set(requisitions.map((r) => r.jobFamily).filter(Boolean))];
    return {
        OR: [
            { links: { some: { isActive: true, scopeType: "REQUISITION", scopeId: { in: ids } } } },
            ...(families.length ? [{ jobFamily: { in: families } }] : []),
        ],
    };
}

/** The visibility predicate for the caller, or throws 403. */
async function visibilityWhere(tenantId, access) {
    if (configAccess(access)) return {};
    if (access?.manager) return managerVisibilityWhere(await managerRequisitions(prisma, tenantId, access.scope));
    throw fail("You are not allowed to see test blueprints", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
}

// ── List / get ───────────────────────────────────────────────────────────────

export async function listTestBlueprints({ tenantId, access, status, jobFamily, blueprintKey, page = 1, limit = 50 } = {}) {
    assertEnabled();
    requireTenant(tenantId);
    const visible = await visibilityWhere(tenantId, access);
    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const pageNo = Math.max(Number(page) || 1, 1);
    const where = withTenant(tenantId, {
        ...visible,
        ...(status ? { status } : {}),
        ...(jobFamily ? { jobFamily: normalizeJobFamily(jobFamily) } : {}),
        ...(blueprintKey ? { blueprintKey: String(blueprintKey) } : {}),
    });
    const [rows, total] = await Promise.all([
        prisma.candidateTestBlueprint.findMany({ where, orderBy: [{ blueprintKey: "asc" }, { version: "desc" }], skip: (pageNo - 1) * take, take }),
        prisma.candidateTestBlueprint.count({ where }),
    ]);
    return { items: rows.map(presentBlueprint), total, page: pageNo, limit: take };
}

export async function getTestBlueprint({ tenantId, access, blueprintId } = {}) {
    assertEnabled();
    requireTenant(tenantId);
    const id = toId(blueprintId, "blueprintId");
    const visible = await visibilityWhere(tenantId, access);
    const row = await prisma.candidateTestBlueprint.findFirst({
        where: withTenant(tenantId, { id, ...visible }),
        include: { links: { where: { isActive: true }, orderBy: { id: "asc" } } },
    });
    if (!row) throw notFound();
    return presentBlueprint(row);
}

// ── Create / update ──────────────────────────────────────────────────────────

function newBlueprintKey(name) {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "blueprint";
    return `${slug}-${randomBytes(3).toString("hex")}`;
}

function blueprintKeyOf(input) {
    if (input.blueprintKey === undefined || input.blueprintKey === null || input.blueprintKey === "") return newBlueprintKey(input.name ?? "");
    const key = String(input.blueprintKey).trim();
    if (!KEY_RE.test(key)) throw fail("blueprintKey must be letters, digits, dot, dash or underscore (at most 80)", 422, "HR-RECRUITMENT-BLUEPRINT-INVALID");
    return key;
}

const keyTaken = (err) => err?.code === "P2002";

export async function createTestBlueprint({ tenantId, access, actorId = null, input = {} } = {}) {
    assertEnabled();
    requireTenant(tenantId);
    assertAssessmentCapability(access, "author", "Only assessment authors and recruiters create test blueprints");
    const value = normalizeBlueprintInput(input);
    const blueprintKey = blueprintKeyOf(input);
    try {
        const row = await prisma.candidateTestBlueprint.create({
            data: withTenant(tenantId, { ...value, blueprintKey, version: 1, status: BLUEPRINT_STATUS.DRAFT, createdById: actorId }),
        });
        return presentBlueprint(row);
    } catch (err) {
        if (keyTaken(err)) throw fail(`A blueprint with key "${blueprintKey}" already exists`, 409, "HR-RECRUITMENT-BLUEPRINT-KEY-TAKEN");
        throw err;
    }
}

const editableOf = (row) => Object.fromEntries(BLUEPRINT_EDITABLE_FIELDS.map((f) => [f, row[f]]));
const pickEditable = (input) => Object.fromEntries(BLUEPRINT_EDITABLE_FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f]]));

const CLEARED_APPROVALS = Object.freeze({
    approvedByHiringManagerId: null,
    hiringManagerApprovedAt: null,
    approvedByHrId: null,
    hrApprovedAt: null,
});

async function createNextVersion(tenantId, current, value, actorId) {
    const versions = await prisma.candidateTestBlueprint.findMany({
        where: withTenant(tenantId, { blueprintKey: current.blueprintKey }),
        select: { id: true, version: true, status: true },
    });
    const pending = versions.find((v) => UNPUBLISHED.includes(v.status));
    if (pending) {
        throw fail("A newer version of this blueprint is already being edited", 409, "HR-RECRUITMENT-BLUEPRINT-DRAFT-EXISTS", { draftBlueprintId: pending.id });
    }
    const version = Math.max(...versions.map((v) => v.version)) + 1;
    try {
        return await prisma.candidateTestBlueprint.create({
            data: withTenant(tenantId, { ...value, blueprintKey: current.blueprintKey, version, status: BLUEPRINT_STATUS.DRAFT, createdById: actorId }),
        });
    } catch (err) {
        if (keyTaken(err)) throw conflict();
        throw err;
    }
}

/**
 * Update a blueprint. A PUBLISHED one is never changed: the edit becomes
 * version + 1 (DRAFT). Unpublished versions are edited in place, guarded on
 * their status and updatedAt, and lose both approvals.
 */
export async function updateTestBlueprint({ tenantId, access, actorId = null, blueprintId, input = {} } = {}) {
    assertEnabled();
    requireTenant(tenantId);
    assertAssessmentCapability(access, "author", "Only assessment authors and recruiters edit test blueprints");
    const id = toId(blueprintId, "blueprintId");
    const current = await loadBlueprint(prisma, tenantId, id);
    if (current.status === BLUEPRINT_STATUS.RETIRED) throw fail("A retired blueprint cannot be edited", 409, "HR-RECRUITMENT-BLUEPRINT-RETIRED");
    const value = normalizeBlueprintInput({ ...editableOf(current), ...pickEditable(input) });
    if (current.status === BLUEPRINT_STATUS.PUBLISHED) {
        const next = await createNextVersion(tenantId, current, value, actorId);
        return { ...presentBlueprint(next), createdVersion: true, previousBlueprintId: current.id };
    }
    const { count } = await prisma.candidateTestBlueprint.updateMany({
        where: withTenant(tenantId, { id, status: current.status, updatedAt: current.updatedAt }),
        data: { ...value, ...CLEARED_APPROVALS, status: BLUEPRINT_STATUS.DRAFT },
    });
    if (!count) throw conflict();
    return { ...presentBlueprint(await loadBlueprint(prisma, tenantId, id)), createdVersion: false };
}

// ── Approve ──────────────────────────────────────────────────────────────────

/** The hiring manager rule (see the header). */
export async function isHiringManagerForBlueprint(db, { tenantId, blueprint, employeeId }) {
    if (!employeeId) return false;
    const linked = await db.candidateTestBlueprintLink.findMany({
        where: withTenant(tenantId, { isActive: true, scopeType: "REQUISITION", blueprint: { blueprintKey: blueprint.blueprintKey } }),
        select: { scopeId: true },
    });
    const linkedIds = new Set(linked.map((l) => l.scopeId).filter((v) => v != null));
    const owned = await db.jobRequisition.findMany({
        where: withTenant(tenantId, { requestedById: Number(employeeId) }),
        select: REQUISITION_SELECT,
        take: MAX_MANAGER_REQUISITIONS,
    });
    const family = normalizeJobFamily(blueprint.jobFamily);
    return owned.some((r) => linkedIds.has(r.id) || (family != null && requisitionJobFamily(r) === family));
}

function approvalData(current, role, actorId, at) {
    const hm = role === "HIRING_MANAGER" ? actorId : current.approvedByHiringManagerId;
    const hr = role === "HR" ? actorId : current.approvedByHrId;
    return {
        ...(role === "HIRING_MANAGER" ? { approvedByHiringManagerId: actorId, hiringManagerApprovedAt: at } : { approvedByHrId: actorId, hrApprovedAt: at }),
        status: hm != null && hr != null ? BLUEPRINT_STATUS.APPROVED : BLUEPRINT_STATUS.IN_APPROVAL,
    };
}

async function assertMayApprove({ tenantId, access, current, role, actorId }) {
    if (role === "HR") {
        if (!access?.recruiter && !access?.admin) throw fail("Only a recruiter or HR admin approves for HR", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
        return;
    }
    const ok = await isHiringManagerForBlueprint(prisma, { tenantId, blueprint: current, employeeId: actorId });
    if (!ok) throw fail("Only the hiring manager of a requisition this test is for may approve as hiring manager", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
}

/**
 * Record the caller's approval as HIRING_MANAGER or HR. The two approvals
 * must come from two different people; approving the same role twice by the
 * same person is idempotent.
 */
export async function approveTestBlueprint({ tenantId, access, actorId = null, blueprintId, as: role, now = new Date() } = {}) {
    assertEnabled();
    requireTenant(tenantId);
    if (!APPROVAL_ROLES.includes(role)) throw fail(`as must be one of ${APPROVAL_ROLES.join(", ")}`, 400, "HR-RECRUITMENT-BLUEPRINT-INVALID");
    if (!actorId) throw fail("Approving needs an employee identity", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    const id = toId(blueprintId, "blueprintId");
    const current = await loadBlueprint(prisma, tenantId, id);
    if (![BLUEPRINT_STATUS.DRAFT, BLUEPRINT_STATUS.IN_APPROVAL].includes(current.status)) {
        throw fail(`A ${current.status} blueprint cannot be approved`, 409, "HR-RECRUITMENT-BLUEPRINT-NOT-APPROVABLE", { status: current.status });
    }
    await assertMayApprove({ tenantId, access, current, role, actorId });
    const mine = role === "HR" ? current.approvedByHrId : current.approvedByHiringManagerId;
    const other = role === "HR" ? current.approvedByHiringManagerId : current.approvedByHrId;
    if (mine != null) {
        if (Number(mine) === Number(actorId)) return presentBlueprint(current);
        throw fail(`This blueprint already has its ${role} approval`, 409, "HR-RECRUITMENT-BLUEPRINT-ALREADY-APPROVED");
    }
    if (other != null && Number(other) === Number(actorId)) {
        throw fail("The hiring manager and HR approvals must come from two different people", 409, "HR-RECRUITMENT-BLUEPRINT-SAME-APPROVER");
    }
    const { count } = await prisma.candidateTestBlueprint.updateMany({
        where: withTenant(tenantId, { id, status: current.status, updatedAt: current.updatedAt }),
        data: approvalData(current, role, Number(actorId), new Date(now)),
    });
    if (!count) throw conflict();
    return presentBlueprint(await loadBlueprint(prisma, tenantId, id));
}

// ── Pool depth and publish ───────────────────────────────────────────────────

function itemPoolWhere(tenantId, blueprint) {
    const family = normalizeJobFamily(blueprint.jobFamily);
    return withTenant(tenantId, {
        status: "PUBLISHED",
        language: blueprint.language,
        competencyKey: { in: (blueprint.sections ?? []).map((s) => s.competencyKey) },
        OR: family ? [{ jobFamily: null }, { jobFamily: { equals: family, mode: "insensitive" } }] : [{ jobFamily: null }],
    });
}

/** Distinct item codes per competency and difficulty in the blueprint's pool. */
export async function loadPoolCounts(db, tenantId, blueprint) {
    const rows = await db.candidateTestItem.findMany({
        where: itemPoolWhere(tenantId, blueprint),
        select: { itemCode: true, competencyKey: true, difficulty: true },
    });
    const seen = new Set();
    const counts = {};
    for (const r of rows) {
        const key = `${r.competencyKey}|${r.difficulty}|${r.itemCode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        counts[r.competencyKey] ??= {};
        counts[r.competencyKey][r.difficulty] = (counts[r.competencyKey][r.difficulty] ?? 0) + 1;
    }
    return counts;
}

export async function testBlueprintPoolReport(db, tenantId, blueprint) {
    const poolCounts = await loadPoolCounts(db, tenantId, blueprint);
    return poolDepthReport({ sections: blueprint.sections ?? [], poolCounts });
}

async function retirePreviousAndMoveLinks(tx, tenantId, blueprint) {
    const previous = await tx.candidateTestBlueprint.findMany({
        where: withTenant(tenantId, { blueprintKey: blueprint.blueprintKey, status: BLUEPRINT_STATUS.PUBLISHED, id: { not: blueprint.id } }),
        select: { id: true },
    });
    const ids = previous.map((p) => p.id);
    if (!ids.length) return { retiredBlueprintIds: [], movedLinkCount: 0 };
    await tx.candidateTestBlueprint.updateMany({
        where: withTenant(tenantId, { id: { in: ids }, status: BLUEPRINT_STATUS.PUBLISHED }),
        data: { status: BLUEPRINT_STATUS.RETIRED },
    });
    const moved = await tx.candidateTestBlueprintLink.updateMany({
        where: withTenant(tenantId, { blueprintId: { in: ids }, isActive: true }),
        data: { blueprintId: blueprint.id },
    });
    return { retiredBlueprintIds: ids, movedLinkCount: moved.count };
}

function assertTwoApprovers(blueprint) {
    const hm = blueprint.approvedByHiringManagerId;
    const hr = blueprint.approvedByHrId;
    if (hm == null || hr == null || Number(hm) === Number(hr)) {
        throw fail("A blueprint is published only after the hiring manager and HR approve it", 409, "HR-RECRUITMENT-BLUEPRINT-NOT-APPROVED");
    }
}

/**
 * Publish an APPROVED blueprint (see the header). One transaction: the pool
 * check, the guarded status claim, the retirement of the previous version,
 * the link move and the event.
 */
export async function publishTestBlueprint({ tenantId, access, actorId = null, blueprintId, now = new Date() } = {}) {
    assertEnabled();
    requireTenant(tenantId);
    assertAssessmentCapability(access, "reviewer", "Only assessment reviewers and recruiters publish test blueprints");
    const id = toId(blueprintId, "blueprintId");
    return tenantTransaction(prisma, async (tx) => {
        const current = await loadBlueprint(tx, tenantId, id);
        if (current.status !== BLUEPRINT_STATUS.APPROVED) {
            throw fail("Only an APPROVED blueprint can be published", 409, "HR-RECRUITMENT-BLUEPRINT-NOT-APPROVED", { status: current.status });
        }
        assertTwoApprovers(current);
        const report = await testBlueprintPoolReport(tx, tenantId, current);
        if (!report.ok) {
            throw fail("The item pool is too shallow to publish this blueprint", 409, "HR-RECRUITMENT-BLUEPRINT-POOL-SHALLOW", { report });
        }
        const publishedAt = new Date(now);
        const { count } = await tx.candidateTestBlueprint.updateMany({
            where: withTenant(tenantId, { id, status: BLUEPRINT_STATUS.APPROVED }),
            data: { status: BLUEPRINT_STATUS.PUBLISHED, publishedAt },
        });
        if (!count) throw conflict();
        const published = { ...current, status: BLUEPRINT_STATUS.PUBLISHED, publishedAt };
        const moved = await retirePreviousAndMoveLinks(tx, tenantId, published);
        await enqueueHrDomainEvent(tx, testBlueprintPublishedEvent(published, { actorId, ...moved }));
        return { blueprint: presentBlueprint(published), ...moved, report };
    }, { tenantId });
}

// ── Link ─────────────────────────────────────────────────────────────────────

function normalizeScope({ scopeType, scopeId, scopeKey }) {
    const type = String(scopeType ?? "").trim().toUpperCase();
    if (!BLUEPRINT_SCOPES.includes(type)) throw fail(`scopeType must be one of ${BLUEPRINT_SCOPES.join(", ")}`, 400, "HR-RECRUITMENT-BLUEPRINT-INVALID");
    const family = normalizeJobFamily(scopeKey);
    if (type === "REQUISITION") return { scopeType: type, scopeId: toId(scopeId, "scopeId (requisition id)"), scopeKey: null };
    if (!family) throw fail("scopeKey (the job family) is required for a job family link", 400, "HR-RECRUITMENT-BLUEPRINT-INVALID");
    if (type === "JOB_FAMILY_GRADE") return { scopeType: type, scopeId: toId(scopeId, "scopeId (grade level id)"), scopeKey: family };
    return { scopeType: type, scopeId: null, scopeKey: family };
}

async function assertMayLink(db, { tenantId, access, actorId, scope }) {
    if (scope.scopeType === "REQUISITION") {
        const requisition = await db.jobRequisition.findFirst({ where: withTenant(tenantId, { id: scope.scopeId }), select: { id: true, requestedById: true } });
        if (!requisition) throw fail("Requisition not found", 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
        if (access?.recruiter) return;
        if (actorId && Number(requisition.requestedById) === Number(actorId)) return;
        throw fail("Only a recruiter or the requisition's hiring manager may link its test", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    }
    if (!access?.recruiter) throw fail("Only a recruiter may link a test to a job family", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    if (scope.scopeType === "JOB_FAMILY_GRADE") {
        const grade = await db.gradeLevel.findFirst({ where: withTenant(tenantId, { id: scope.scopeId }), select: { id: true } });
        if (!grade) throw fail("Grade level not found", 404, "HR-RECRUITMENT-GRADE-NOT-FOUND");
    }
}

const scopeWhere = (tenantId, scope) => withTenant(tenantId, { scopeType: scope.scopeType, scopeId: scope.scopeId, scopeKey: scope.scopeKey, isActive: true });

/**
 * Link a blueprint to a scope, deactivating the scope's previous active link.
 */
export async function linkTestBlueprint({ tenantId, access, actorId = null, blueprintId, scopeType, scopeId, scopeKey } = {}) {
    assertEnabled();
    requireTenant(tenantId);
    const id = toId(blueprintId, "blueprintId");
    const scope = normalizeScope({ scopeType, scopeId, scopeKey });
    return tenantTransaction(prisma, async (tx) => {
        const blueprint = await loadBlueprint(tx, tenantId, id);
        await assertMayLink(tx, { tenantId, access, actorId, scope });
        if (blueprint.status === BLUEPRINT_STATUS.RETIRED) throw fail("A retired blueprint cannot be linked", 409, "HR-RECRUITMENT-BLUEPRINT-RETIRED");
        const existing = await tx.candidateTestBlueprintLink.findFirst({ where: scopeWhere(tenantId, scope), include: { blueprint: { select: { id: true, status: true } } } });
        if (existing?.blueprintId === id) return { link: presentLink(existing), replacedLinkId: null, unchanged: true };
        if (blueprint.status !== BLUEPRINT_STATUS.PUBLISHED && existing?.blueprint?.status === BLUEPRINT_STATUS.PUBLISHED) {
            throw fail("This scope has a published test; publish this blueprint before linking it", 409, "HR-RECRUITMENT-BLUEPRINT-LINK-WOULD-UNLINK", { activeBlueprintId: existing.blueprintId });
        }
        if (existing) await tx.candidateTestBlueprintLink.updateMany({ where: withTenant(tenantId, { id: existing.id, isActive: true }), data: { isActive: false } });
        try {
            const link = await tx.candidateTestBlueprintLink.create({ data: withTenant(tenantId, { blueprintId: id, ...scope, isActive: true, createdById: actorId }) });
            return { link: presentLink(link), replacedLinkId: existing?.id ?? null, unchanged: false };
        } catch (err) {
            if (keyTaken(err)) throw conflict();
            throw err;
        }
    }, { tenantId });
}

// ── Resolve ──────────────────────────────────────────────────────────────────

async function loadRequisition(db, tenantId, requisitionId) {
    const row = await db.jobRequisition.findFirst({ where: withTenant(tenantId, { id: requisitionId }), select: REQUISITION_SELECT });
    return row ? { ...row, jobFamily: requisitionJobFamily(row) } : null;
}

/**
 * The published blueprint that applies to a requisition and the scope that
 * matched, or null. Shared by the resolve tool and the scheduling hook.
 */
export async function resolveBlueprintForRequisition(db, { tenantId, requisition }) {
    const family = requisition.jobFamily ?? null;
    const scopes = [
        { scopeType: "REQUISITION", scopeId: requisition.id },
        ...(family && requisition.gradeLevelId != null ? [{ scopeType: "JOB_FAMILY_GRADE", scopeId: requisition.gradeLevelId, scopeKey: family }] : []),
        ...(family ? [{ scopeType: "JOB_FAMILY", scopeKey: family }] : []),
    ];
    const links = await db.candidateTestBlueprintLink.findMany({
        where: withTenant(tenantId, { isActive: true, OR: scopes }),
        include: { blueprint: true },
    });
    return pickBlueprintLink(links, { requisitionId: requisition.id, jobFamily: family, gradeLevelId: requisition.gradeLevelId ?? null });
}

async function assertMayResolve(tenantId, access, requisitionId) {
    if (configAccess(access)) return;
    if (access?.manager) {
        const own = await prisma.jobRequisition.findFirst({ where: withTenant(tenantId, { id: requisitionId, ...requisitionScopeWhere(access.scope) }), select: { id: true } });
        if (own) return;
        throw fail("Requisition not found", 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
    }
    throw fail("You are not allowed to resolve test blueprints", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
}

export async function resolveTestBlueprint({ tenantId, access, requisitionId } = {}) {
    assertEnabled();
    requireTenant(tenantId);
    const id = toId(requisitionId, "requisitionId");
    await assertMayResolve(tenantId, access, id);
    const requisition = await loadRequisition(prisma, tenantId, id);
    if (!requisition) throw fail("Requisition not found", 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
    const hit = await resolveBlueprintForRequisition(prisma, { tenantId, requisition });
    return {
        requisitionId: id,
        jobFamily: requisition.jobFamily,
        gradeLevelId: requisition.gradeLevelId ?? null,
        matchedScope: hit?.matchedScope ?? null,
        linkId: hit?.link?.id ?? null,
        blueprint: hit ? presentBlueprint(hit.blueprint) : null,
    };
}

// ── Preview ──────────────────────────────────────────────────────────────────

// What a preview may show of an item: the candidate's view, nothing more.
const PREVIEW_ITEM_SELECT = Object.freeze({
    id: true,
    itemCode: true,
    version: true,
    type: true,
    stem: true,
    mediaId: true,
    options: true,
    competencyKey: true,
    difficulty: true,
});

function shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = randomInt(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

const candidateOptions = (options) =>
    Array.isArray(options) ? shuffle(options.map((o) => ({ id: o?.id ?? null, text: o?.text ?? "" }))) : null;

const presentPreviewItem = (item) => ({
    itemCode: item.itemCode,
    version: item.version,
    type: item.type,
    stem: item.stem,
    mediaId: item.mediaId ?? null,
    options: candidateOptions(item.options),
    difficulty: item.difficulty,
});

function latestPerCode(rows) {
    const byCode = new Map();
    for (const r of rows) {
        const cur = byCode.get(r.itemCode);
        if (!cur || r.version > cur.version) byCode.set(r.itemCode, r);
    }
    return [...byCode.values()];
}

/**
 * A sample draw of the test a candidate would get. Read-only: no exposure
 * count is touched and no answer key, rationale or feedback is selected.
 */
export async function previewTestBlueprint({ tenantId, access, blueprintId } = {}) {
    assertEnabled();
    requireTenant(tenantId);
    if (!configAccess(access)) throw fail("Only recruiters, reviewers and authors preview tests", 403, "HR-RECRUITMENT-ASSESSMENT-FORBIDDEN");
    const id = toId(blueprintId, "blueprintId");
    const blueprint = await loadBlueprint(prisma, tenantId, id);
    const rows = await prisma.candidateTestItem.findMany({ where: itemPoolWhere(tenantId, blueprint), select: PREVIEW_ITEM_SELECT });
    const pool = latestPerCode(rows);
    const sections = drawPlan(blueprint.sections ?? []).map((plan) => {
        const items = [];
        const shortfall = {};
        for (const difficulty of DIFFICULTIES) {
            const want = plan.counts[difficulty];
            if (!want) continue;
            const candidates = pool.filter((i) => i.competencyKey === plan.competencyKey && i.difficulty === difficulty);
            const drawn = shuffle(candidates).slice(0, want);
            if (drawn.length < want) shortfall[difficulty] = want - drawn.length;
            items.push(...drawn.map(presentPreviewItem));
        }
        const section = (blueprint.sections ?? []).find((s) => s.key === plan.sectionKey) ?? {};
        return { key: plan.sectionKey, label: section.label ?? plan.competencyKey, competencyKey: plan.competencyKey, timeLimitMin: section.timeLimitMin ?? null, items: shuffle(items), shortfall };
    });
    return {
        blueprintId: blueprint.id,
        version: blueprint.version,
        status: blueprint.status,
        sample: true,
        durationMin: blueprint.durationMin,
        navigation: blueprint.navigation,
        flagForReview: blueprint.flagForReview,
        sections,
    };
}

// ── The scheduling hook ──────────────────────────────────────────────────────

const RESULT_SELECT = Object.freeze({ id: true, band: true, decision: true, validUntil: true, createdAt: true, jobFamily: true, blueprintId: true });

// The candidate's earlier results for the same job family (or, when the
// blueprint has no family, for this very blueprint).
async function priorResults(tx, { tenantId, candidateId, jobFamily, blueprintId }) {
    return tx.candidateTestResult.findMany({
        where: withTenant(tenantId, {
            candidateId,
            ...(jobFamily ? { jobFamily: { equals: jobFamily, mode: "insensitive" } } : { blueprintId }),
        }),
        select: RESULT_SELECT,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
    });
}

/**
 * Phase 3b — called by the schedule path (scheduleInterviewInTransaction, so
 * the recruiter's schedule and the candidate's slot confirm both pass here)
 * in the interview's own transaction. When the flag is on, the interview is
 * on site and its requisition resolves a published blueprint, the interview
 * becomes assessment-required (or PASSED when a still-valid result is
 * reused) and interview_assessment_required is enqueued.
 *
 * @returns {Promise<null|{ fields: object, blueprintId: number, matchedScope: string, reusedResultId: number|null, cooldownActive: boolean }>}
 */
export async function markInterviewAssessmentInTransaction(tx, { interview, application, tenantId, now = new Date() } = {}) {
    if (!isRecruitmentFlagEnabled("onsiteTest")) return null;
    if (!tenantId || !interview?.id || !application?.jobRequisitionId) return null;
    if (!isOnsiteInterview(interview)) return null;
    const requisition = await loadRequisition(tx, tenantId, Number(application.jobRequisitionId));
    if (!requisition) return null;
    const hit = await resolveBlueprintForRequisition(tx, { tenantId, requisition });
    if (!hit) return null;
    // Results carry their blueprint's job family (the scorer writes it), so
    // reuse and cooldown compare on the blueprint's family, not the
    // requisition's derived one.
    const jobFamily = normalizeJobFamily(hit.blueprint.jobFamily);
    const results = application.candidateId != null
        ? await priorResults(tx, { tenantId, candidateId: application.candidateId, jobFamily, blueprintId: hit.blueprint.id })
        : [];
    const requirement = assessmentRequirementFor({ results, now, retakeCooldownDays: hit.blueprint.retakeCooldownDays });
    const fields = { assessmentRequired: true, assessmentStatus: requirement.assessmentStatus, assessmentBlueprintId: hit.blueprint.id };
    await tx.interview.updateMany({ where: withTenant(tenantId, { id: interview.id }), data: fields });
    await enqueueHrDomainEvent(tx, interviewAssessmentRequiredEvent({
        tenantId,
        interviewId: interview.id,
        applicationId: application.id ?? interview.applicationId,
        candidateId: application.candidateId,
        requisitionId: requisition.id,
        blueprint: hit.blueprint,
        matchedScope: hit.matchedScope,
        requirement,
    }));
    logger.debug({ interviewId: interview.id, blueprintId: hit.blueprint.id, matchedScope: hit.matchedScope, reused: requirement.reusedResultId != null }, "interview marked assessment-required");
    return { fields, blueprintId: hit.blueprint.id, matchedScope: hit.matchedScope, reusedResultId: requirement.reusedResultId, cooldownActive: requirement.cooldownActive };
}
