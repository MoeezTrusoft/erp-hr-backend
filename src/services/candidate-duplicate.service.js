// src/services/candidate-duplicate.service.js
//
// Recruitment Phase 2 — duplicate candidate detection and merge suggestions
// (flag `duplicates`, env HR_RECRUITMENT_DUPLICATES, default OFF).
//
// "Detect candidates sharing email, phone or parsed identity; propose a merge
// with conflict detection. Recruiter confirms the merge." The pure matching
// (normalisers, scorePair, conflicts) lives in candidate-duplicate-match.util.js;
// this module decides WHICH rows to compare, stores the suggestions, and runs
// the recruiter's MERGE / DISMISS decision through the existing merge service.
//
// WHICH ROWS (no O(n^2) scan). The job examines the candidates of each tenant
// whose updatedAt falls inside a lookback window (default 25h, env
// HR_RECRUITMENT_DUPLICATES_LOOKBACK_HOURS) — every create, edit, parse or merge
// bumps updatedAt, so a run on a 1h-24h cadence with an overlapping window sees
// every change at least once and re-examining a row is harmless. Each examined
// row is compared only against the rows one blocking query returns (same
// canonical email or its +tag variants, same last 4 phone digits, same
// first+last name, same resume content hash), capped at BLOCK_LIMIT. gmail dot
// variants cannot be expressed as a Prisma predicate; they surface through the
// name and phone blocks and are confirmed by scorePair. Pairs where BOTH rows
// pre-date the flag are found by runCandidateDuplicateBackfill (id-keyset walk).
//
// WHAT IS STORED. One row per (tenant, lower id, higher id) — the migration's
// order CHECK. MERGED and DISMISSED are terminal: a later run never reopens
// them. An OPEN row's score and signals follow the data. Only ACTIVE,
// non-anonymized candidates are compared (a merged-away row is archived, so the
// pair is not re-proposed); a candidate under legal hold is skipped entirely.
//
// MERGE. candidateMerge.service.js runs its own transaction and cannot join
// ours, so the suggestion is CLAIMED first (OPEN -> MERGED with an atomic
// updateMany, so two recruiters cannot merge one pair twice), the merge runs,
// and a failed merge puts the claim back to OPEN. Other OPEN suggestions that
// name the merged-away row are then DISMISSED with note MERGED_ELSEWHERE rather
// than re-pointed: re-pointing could collide with an existing (survivor, X)
// pair, and the score was computed against an identity that no longer exists.
// The merge bumps the survivor's updatedAt, so the next run re-evaluates it
// against X under its merged identity.
//
// SCOPE. Duplicates expose candidates across requisitions, so every read and
// write is ORG only: a narrower scope lists an empty page and is refused writes.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { eventContext } from "../lib/event-context.util.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { maskCandidateForScope } from "../lib/recruitmentAccess.js";
import {
    normalizeEmailKey,
    normalizePhoneKey,
    normalizeName,
    orderedPair,
    pairConflicts,
    resumeHashOf,
    scorePair,
} from "../lib/candidate-duplicate-match.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { mergeCandidates } from "./candidateMerge.service.js";

const log = logger.child({ component: "candidate-duplicate" });

export const DUPLICATE_RESOLVED_EVENT = "hr.recruitment.candidate_duplicate_resolved.v1";
export const DUPLICATE_STATUSES = Object.freeze(["OPEN", "MERGED", "DISMISSED"]);
export const MERGED_ELSEWHERE_NOTE = "MERGED_ELSEWHERE";

const BLOCK_LIMIT = 25; // rows one blocking query may return per examined candidate
const DEFAULT_LOOKBACK_HOURS = 25;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const HOUR_MS = 60 * 60 * 1000;

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

// Fields the matcher reads. parsedResume carries the content hash (and any
// profile URL a richer parse adds).
const MATCH_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    status: true,
    consentStatus: true,
    anonymizedAt: true,
    parsedResume: true,
});

// What the ORG candidate list shows of a candidate (no notes, no parse JSON).
const DISPLAY_SELECT = Object.freeze({
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    source: true,
    location: true,
    status: true,
    consentStatus: true,
    anonymizedAt: true,
    archivedAt: true,
    createdAt: true,
});

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

export function lookbackHoursFrom(env = process.env) {
    const n = Number(env.HR_RECRUITMENT_DUPLICATES_LOOKBACK_HOURS);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOOKBACK_HOURS;
}

const requireOrg = (scope) => {
    if (!scope?.unrestricted) {
        throw fail("Duplicate candidates are a recruiter (organisation-wide) view", 403, "HR-RECRUITMENT-DUPLICATES-ORG-ONLY");
    }
};

const requireFlag = () => {
    if (!isRecruitmentFlagEnabled("duplicates")) {
        throw fail("Duplicate candidate detection is disabled", 503, "HR-RECRUITMENT-DUPLICATES-DISABLED");
    }
};

// ── Blocking ────────────────────────────────────────────────────────────────

const insensitive = (value) => ({ equals: value, mode: "insensitive" });

function emailClauses(email) {
    const key = normalizeEmailKey(email);
    if (!key) return [];
    const domains = key.domain === "gmail.com" ? ["gmail.com", "googlemail.com"] : [key.domain];
    const clauses = [{ email: insensitive(String(email).trim()) }];
    for (const domain of domains) {
        clauses.push({ email: insensitive(`${key.local}@${domain}`) });
        clauses.push({
            AND: [
                { email: { startsWith: `${key.local}+`, mode: "insensitive" } },
                { email: { endsWith: `@${domain}`, mode: "insensitive" } },
            ],
        });
    }
    return clauses;
}

function nameClauses(candidate) {
    const first = String(candidate.firstName ?? "").trim();
    const last = String(candidate.lastName ?? "").trim();
    if (!first || !last) return [];
    const forms = new Set([`${first}\u0000${last}`]);
    const plainFirst = normalizeName(first);
    const plainLast = normalizeName(last);
    if (plainFirst && plainLast) forms.add(`${plainFirst}\u0000${plainLast}`);
    return [...forms].map((form) => {
        const [f, l] = form.split("\u0000");
        return { firstName: insensitive(f), lastName: insensitive(l) };
    });
}

/**
 * The OR-clauses of the blocking query for one candidate. Every clause is a
 * narrow equality / prefix / suffix predicate; there is no clause that matches
 * the whole tenant. Exported for tests.
 */
export function blockingClauses(candidate) {
    const clauses = [...emailClauses(candidate.email), ...nameClauses(candidate)];
    const phone = normalizePhoneKey(candidate.phone);
    if (phone) clauses.push({ phone: { endsWith: phone.slice(-4) } });
    const hash = resumeHashOf(candidate.parsedResume);
    if (hash) clauses.push({ parsedResume: { path: ["contentHash"], equals: hash } });
    return clauses;
}

async function activeHolds(tenantId, candidateIds) {
    if (!candidateIds.length) return new Set();
    const rows = await prisma.candidateLegalHold.findMany({
        where: withTenant(tenantId, { candidateId: { in: candidateIds }, releasedAt: null }),
        select: { candidateId: true },
    });
    return new Set(rows.map((row) => row.candidateId));
}

// ── Suggestion upsert ───────────────────────────────────────────────────────

// Key-order-insensitive: jsonb hands the stored object back with its keys
// reordered, so a JSON.stringify comparison would report every pair changed.
const sameSignals = (stored, next) => {
    const a = stored && typeof stored === "object" ? stored : {};
    const keys = new Set([...Object.keys(a), ...Object.keys(next ?? {})]);
    return [...keys].every((key) => a[key] === next?.[key]);
};

/**
 * Insert-if-absent, update-if-OPEN, never touch MERGED/DISMISSED. Returns the
 * outcome name. createMany+skipDuplicates makes a concurrent insert a no-op.
 */
async function upsertSuggestion(tenantId, pair, { score, signals, suggest }) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const existing = await tx.candidateDuplicateSuggestion.findUnique({
                where: { tenantId_candidateAId_candidateBId: { tenantId, ...pair } },
                select: { id: true, status: true, score: true, signals: true },
            });
            if (!existing) {
                if (!suggest) return "below";
                const { count } = await tx.candidateDuplicateSuggestion.createMany({
                    data: [{ tenantId, ...pair, score, signals, status: "OPEN" }],
                    skipDuplicates: true,
                });
                return count ? "created" : "unchanged";
            }
            if (existing.status !== "OPEN") return "terminal";
            if (existing.score === score && sameSignals(existing.signals, signals)) return "unchanged";
            await tx.candidateDuplicateSuggestion.updateMany({
                where: withTenant(tenantId, { id: existing.id, status: "OPEN" }),
                data: { score, signals },
            });
            return "updated";
        },
        { tenantId },
    );
}

const emptySummary = () => ({
    examined: 0, created: 0, updated: 0, unchanged: 0, terminal: 0, below: 0, skippedLegalHold: 0, failed: 0,
});

/** Compare one candidate against its blocking matches and store the pairs. */
async function detectForCandidate(tenantId, candidate, summary) {
    summary.examined += 1;
    if (candidate.anonymizedAt || candidate.status !== "active") return;
    const clauses = blockingClauses(candidate);
    if (!clauses.length) return;

    const matches = await prisma.candidate.findMany({
        where: withTenant(tenantId, {
            id: { not: candidate.id },
            status: "active",
            anonymizedAt: null,
            OR: clauses,
        }),
        select: MATCH_SELECT,
        orderBy: { id: "asc" },
        take: BLOCK_LIMIT,
    });
    if (!matches.length) return;

    const held = await activeHolds(tenantId, [candidate.id, ...matches.map((m) => m.id)]);
    if (held.has(candidate.id)) {
        summary.skippedLegalHold += 1;
        return;
    }
    for (const match of matches) {
        if (held.has(match.id) || match.anonymizedAt) continue;
        const outcome = await upsertSuggestion(tenantId, orderedPair(candidate.id, match.id), scorePair(candidate, match));
        summary[outcome] += 1;
    }
}

async function detectAll(tenantId, rows, summary) {
    for (const candidate of rows) {
        try {
            await detectForCandidate(tenantId, candidate, summary);
        } catch (err) {
            // One bad row never stops the tenant.
            summary.failed += 1;
            log.error({ errMessage: err?.message, tenantId, candidateId: candidate.id }, "duplicate detection: candidate failed");
        }
    }
    return summary;
}

/** One tenant's incremental pass: candidates changed since `since`. */
export async function detectDuplicatesForTenant({ tenantId, since, limit = 500 } = {}) {
    const rows = await prisma.candidate.findMany({
        where: withTenant(tenantId, { status: "active", anonymizedAt: null, updatedAt: { gte: since } }),
        select: MATCH_SELECT,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit,
    });
    return detectAll(tenantId, rows, emptySummary());
}

/**
 * Scheduled job. Flag-checked; finds the tenants with candidates changed in the
 * lookback window (SYSTEM context), then runs each tenant under its own tenant
 * context so one tenant's failure never stops the others.
 */
export async function runCandidateDuplicateDetectionJob({ now = new Date(), limit = 500, lookbackHours } = {}) {
    if (!isRecruitmentFlagEnabled("duplicates")) return { skipped: "FLAG_OFF" };
    const hours = Number(lookbackHours) > 0 ? Number(lookbackHours) : lookbackHoursFrom();
    const since = new Date(new Date(now).getTime() - hours * HOUR_MS);

    // Prisma queries are lazy: await INSIDE the callback so the query runs
    // under the SYSTEM context, not after run() has returned.
    const tenantRows = await mcpCtx.run({ system: true }, async () =>
        await prisma.candidate.findMany({
            where: { tenantId: { not: null }, status: "active", anonymizedAt: null, updatedAt: { gte: since } },
            select: { tenantId: true },
            distinct: ["tenantId"],
        }),
    );
    const tenants = tenantRows.map((row) => row.tenantId).filter(Boolean);

    const totals = emptySummary();
    const perTenant = [];
    for (const tenantId of tenants) {
        try {
            const result = await mcpCtx.run({ user: { tenantId } }, async () => await detectDuplicatesForTenant({ tenantId, since, limit }));
            for (const key of Object.keys(totals)) totals[key] += result[key];
            perTenant.push({ tenantId, ...result });
        } catch (err) {
            log.error({ errMessage: err?.message, tenantId }, "duplicate detection: tenant failed");
            perTenant.push({ tenantId, error: err?.message ?? "unknown" });
        }
    }
    log.info({ tenants: tenants.length, ...totals }, "duplicate detection job: done");
    return { tenants: tenants.length, since, ...totals, perTenant };
}

/**
 * One-off backfill for pairs where both rows pre-date the flag: walks one
 * tenant's active candidates by id. Call repeatedly with the returned
 * nextAfterId until it is null.
 */
export async function runCandidateDuplicateBackfill({ tenantId, afterId = 0, limit = 200 } = {}) {
    if (!isRecruitmentFlagEnabled("duplicates")) return { skipped: "FLAG_OFF" };
    if (!tenantId) throw fail("Verified company is required", 403, "HR-TENANT-REQUIRED");
    return mcpCtx.run({ user: { tenantId } }, async () => {
        const rows = await prisma.candidate.findMany({
            where: withTenant(tenantId, { id: { gt: Number(afterId) || 0 }, status: "active", anonymizedAt: null }),
            select: MATCH_SELECT,
            orderBy: { id: "asc" },
            take: limit,
        });
        const summary = await detectAll(tenantId, rows, emptySummary());
        return { ...summary, nextAfterId: rows.length === limit ? rows[rows.length - 1].id : null };
    });
}

/** Detect now for one candidate (the hr_candidate_duplicate_detect tool). */
export async function detectCandidateDuplicates({ tenantId, scope, candidateId } = {}) {
    requireFlag();
    requireOrg(scope);
    const id = positiveInt(candidateId);
    if (!id) throw fail("A candidate id is required", 400, "HR-RECRUITMENT-DUPLICATE-INPUT-INVALID");
    const candidate = await prisma.candidate.findFirst({ where: withTenant(tenantId, { id }), select: MATCH_SELECT });
    if (!candidate) throw fail("Candidate not found", 404, "HR-RECRUITMENT-DUPLICATE-NOT-FOUND");
    const summary = emptySummary();
    await detectForCandidate(tenantId, candidate, summary);
    return { candidateId: id, ...summary };
}

// ── Listing ─────────────────────────────────────────────────────────────────

// Defence in depth: whatever the column holds, only booleans leave this module.
const booleanSignals = (signals) =>
    Object.fromEntries(
        Object.entries(signals && typeof signals === "object" ? signals : {}).map(([key, value]) => [key, value === true]),
    );

async function conflictInputs(tenantId, candidateIds) {
    if (!candidateIds.length) return { appsBy: new Map(), held: new Set() };
    const [apps, held] = await Promise.all([
        prisma.application.findMany({
            where: withTenant(tenantId, { candidateId: { in: candidateIds } }),
            select: { candidateId: true, jobRequisitionId: true, stage: true },
        }),
        activeHolds(tenantId, candidateIds),
    ]);
    const appsBy = new Map();
    for (const app of apps) {
        if (!appsBy.has(app.candidateId)) appsBy.set(app.candidateId, []);
        appsBy.get(app.candidateId).push(app);
    }
    return { appsBy, held };
}

function presentSuggestion(row, { appsBy, held }, scope) {
    const withContext = (c) => (c ? { ...c, legalHold: held.has(c.id), applications: appsBy.get(c.id) ?? [] } : c);
    return {
        id: row.id,
        status: row.status,
        score: row.score,
        signals: booleanSignals(row.signals),
        conflicts: row.candidateA && row.candidateB ? pairConflicts(withContext(row.candidateA), withContext(row.candidateB)) : [],
        candidateA: maskCandidateForScope(row.candidateA ? { ...row.candidateA, legalHold: held.has(row.candidateA.id) } : null, scope),
        candidateB: maskCandidateForScope(row.candidateB ? { ...row.candidateB, legalHold: held.has(row.candidateB.id) } : null, scope),
        detectedAt: row.detectedAt,
        updatedAt: row.updatedAt,
        resolvedById: row.resolvedById,
        resolvedAt: row.resolvedAt,
        resolutionNote: row.resolutionNote,
    };
}

/**
 * List suggestions (works with the flag off: shows what was detected). ORG
 * only; a narrower scope gets an empty page, never a 403 (recruitmentAccess).
 * Conflicts are computed fresh from the candidates' current applications and
 * holds, never stored.
 */
export async function listDuplicateSuggestions({ tenantId, scope, status = "OPEN", candidateId, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const pageNum = positiveInt(page) ?? 1;
    const size = Math.min(positiveInt(pageSize) ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    if (!scope?.unrestricted) return { items: [], total: 0, page: pageNum, pageSize: size };
    if (status && status !== "ALL" && !DUPLICATE_STATUSES.includes(status)) {
        throw fail(`status must be one of ${DUPLICATE_STATUSES.join(", ")} or ALL`, 400, "HR-RECRUITMENT-DUPLICATE-INPUT-INVALID");
    }
    const id = candidateId != null && candidateId !== "" ? positiveInt(candidateId) : null;
    if (candidateId != null && candidateId !== "" && !id) {
        throw fail("candidateId must be a positive integer", 400, "HR-RECRUITMENT-DUPLICATE-INPUT-INVALID");
    }

    const where = withTenant(tenantId, {
        ...(status && status !== "ALL" ? { status } : {}),
        ...(id ? { OR: [{ candidateAId: id }, { candidateBId: id }] } : {}),
    });
    const [rows, total] = await Promise.all([
        prisma.candidateDuplicateSuggestion.findMany({
            where,
            include: { candidateA: { select: DISPLAY_SELECT }, candidateB: { select: DISPLAY_SELECT } },
            orderBy: [{ score: "desc" }, { id: "desc" }],
            skip: (pageNum - 1) * size,
            take: size,
        }),
        prisma.candidateDuplicateSuggestion.count({ where }),
    ]);
    const ids = [...new Set(rows.flatMap((row) => [row.candidateAId, row.candidateBId]))];
    const inputs = await conflictInputs(tenantId, ids);
    return { items: rows.map((row) => presentSuggestion(row, inputs, scope)), total, page: pageNum, pageSize: size };
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** Pure event builder: ids only. */
export function candidateDuplicateResolvedEvent(suggestion, ctx = {}, { action, survivorId = null, mergedId = null } = {}) {
    if (!suggestion?.tenantId) return null;
    return {
        eventName: DUPLICATE_RESOLVED_EVENT,
        tenantId: suggestion.tenantId,
        aggregateType: "CandidateDuplicateSuggestion",
        aggregateId: suggestion.id,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            suggestionId: String(suggestion.id),
            action,
            survivorId: survivorId != null ? String(survivorId) : null,
            mergedId: mergedId != null ? String(mergedId) : null,
        },
    };
}

async function loadSuggestion(tenantId, id) {
    const row = await prisma.candidateDuplicateSuggestion.findFirst({ where: withTenant(tenantId, { id }) });
    if (!row) throw fail("Duplicate suggestion not found", 404, "HR-RECRUITMENT-DUPLICATE-NOT-FOUND");
    return row;
}

function assertResolvable(row, expectedStatus) {
    if (expectedStatus && expectedStatus !== row.status) {
        throw fail(`Suggestion is ${row.status}, not ${expectedStatus}`, 409, "HR-RECRUITMENT-DUPLICATE-STATUS-CONFLICT", { status: row.status });
    }
    if (row.status !== "OPEN") {
        throw fail(`Suggestion is already ${row.status}`, 409, "HR-RECRUITMENT-DUPLICATE-STATUS-CONFLICT", { status: row.status });
    }
}

// The hard refusals, checked before the claim with codes of our own; the merge
// service re-checks them inside its own flow.
async function assertMergeAllowed(tenantId, survivorId, mergedId) {
    const rows = await prisma.candidate.findMany({
        where: withTenant(tenantId, { id: { in: [survivorId, mergedId] } }),
        select: { id: true, status: true, anonymizedAt: true },
    });
    if (rows.length !== 2) throw fail("Candidate not found", 404, "HR-RECRUITMENT-DUPLICATE-NOT-FOUND");
    const anonymized = rows.filter((c) => c.anonymizedAt).map((c) => c.id);
    if (anonymized.length) {
        throw fail("An anonymized candidate cannot be merged", 409, "HR-RECRUITMENT-DUPLICATE-ANONYMIZED", { candidateIds: anonymized });
    }
    const held = [...(await activeHolds(tenantId, [survivorId, mergedId]))];
    if (held.length) {
        throw fail("A candidate under legal hold cannot be merged", 409, "HR-RECRUITMENT-DUPLICATE-LEGAL-HOLD", { candidateIds: held });
    }
    const merged = rows.find((c) => c.id === mergedId);
    if (merged.status !== "active") {
        throw fail("Only an active candidate can be merged away; choose it as the survivor", 409, "HR-RECRUITMENT-DUPLICATE-SOURCE-INACTIVE", { candidateIds: [mergedId] });
    }
}

const resolution = (status, actorId, note, at) => ({
    status,
    resolvedById: positiveInt(actorId),
    resolvedAt: at,
    resolutionNote: note ? String(note).slice(0, 500) : null,
});

async function claim(tenantId, row, data) {
    const { count } = await tenantTransaction(
        prisma,
        async (tx) => await tx.candidateDuplicateSuggestion.updateMany({ where: withTenant(tenantId, { id: row.id, status: "OPEN" }), data }),
        { tenantId },
    );
    if (!count) throw fail("Suggestion was resolved by someone else", 409, "HR-RECRUITMENT-DUPLICATE-STATUS-CONFLICT");
}

async function releaseClaim(tenantId, row, claimedAt) {
    try {
        await tenantTransaction(
            prisma,
            async (tx) => await tx.candidateDuplicateSuggestion.updateMany({
                where: withTenant(tenantId, { id: row.id, status: "MERGED", resolvedAt: claimedAt }),
                data: { status: "OPEN", resolvedById: null, resolvedAt: null, resolutionNote: null },
            }),
            { tenantId },
        );
    } catch (err) {
        log.error({ errMessage: err?.message, tenantId, suggestionId: row.id }, "duplicate merge: could not release the claim after a failed merge");
    }
}

async function resolveMerge({ tenantId, row, survivorId, actorId, note, keepSurvivorOnConflict }) {
    const survivor = positiveInt(survivorId);
    if (!survivor || (survivor !== row.candidateAId && survivor !== row.candidateBId)) {
        throw fail("survivorId must be one of the two candidates of the suggestion", 400, "HR-RECRUITMENT-DUPLICATE-SURVIVOR-INVALID");
    }
    const mergedId = survivor === row.candidateAId ? row.candidateBId : row.candidateAId;
    await assertMergeAllowed(tenantId, survivor, mergedId);

    const at = new Date();
    await claim(tenantId, row, resolution("MERGED", actorId, note, at));
    let merge;
    try {
        merge = await mergeCandidates({
            tenantId,
            sourceId: mergedId,
            targetId: survivor,
            actorId: positiveInt(actorId),
            keepTargetOnConflict: keepSurvivorOnConflict === true,
        });
    } catch (err) {
        await releaseClaim(tenantId, row, at);
        throw err;
    }

    const siblingsClosed = await closeSiblingsAndEmit({ tenantId, row, survivorId: survivor, mergedId, actorId, at });
    return { id: row.id, status: "MERGED", survivorId: survivor, mergedId, siblingsClosed, merge };
}

// After a committed merge: dismiss the other OPEN pairs naming the merged-away
// row and emit the event, in one transaction. The merge itself is already
// committed, so a failure here is logged and reported (siblingsClosed null)
// rather than thrown — throwing would tell the recruiter a merge that happened
// did not.
async function closeSiblingsAndEmit({ tenantId, row, survivorId, mergedId, actorId, at }) {
    const ctx = eventContext({ actorId });
    try {
        return await tenantTransaction(
            prisma,
            async (tx) => {
                const { count } = await tx.candidateDuplicateSuggestion.updateMany({
                    where: withTenant(tenantId, {
                        id: { not: row.id },
                        status: "OPEN",
                        OR: [{ candidateAId: mergedId }, { candidateBId: mergedId }],
                    }),
                    data: resolution("DISMISSED", actorId, MERGED_ELSEWHERE_NOTE, at),
                });
                await enqueueHrDomainEvent(tx, candidateDuplicateResolvedEvent(row, ctx, { action: "MERGE", survivorId, mergedId }));
                return count;
            },
            { tenantId },
        );
    } catch (err) {
        log.error({ errMessage: err?.message, tenantId, suggestionId: row.id }, "duplicate merge: merged, but closing sibling suggestions / the event failed");
        return null;
    }
}

async function resolveDismiss({ tenantId, row, actorId, note }) {
    const ctx = eventContext({ actorId });
    await tenantTransaction(
        prisma,
        async (tx) => {
            const { count } = await tx.candidateDuplicateSuggestion.updateMany({
                where: withTenant(tenantId, { id: row.id, status: "OPEN" }),
                data: resolution("DISMISSED", actorId, note, new Date()),
            });
            if (!count) throw fail("Suggestion was resolved by someone else", 409, "HR-RECRUITMENT-DUPLICATE-STATUS-CONFLICT");
            await enqueueHrDomainEvent(tx, candidateDuplicateResolvedEvent(row, ctx, { action: "DISMISS" }));
        },
        { tenantId },
    );
    return { id: row.id, status: "DISMISSED", survivorId: null, mergedId: null };
}

/**
 * Resolve one OPEN suggestion. ORG only.
 *   MERGE   survivorId (one of the pair) keeps its identity; the other row is
 *           folded into it by candidateMerge.service. A live application to the
 *           same requisition on both rows is refused by the merge service unless
 *           keepSurvivorOnConflict is true (the recruiter confirmed it).
 *   DISMISS records who, when and why; the pair is never re-proposed.
 * Emits hr.recruitment.candidate_duplicate_resolved.v1.
 */
export async function resolveDuplicateSuggestion({
    tenantId, scope, id, action, survivorId, actorId = null, note = null, expectedStatus = "OPEN", keepSurvivorOnConflict = false,
} = {}) {
    requireOrg(scope);
    const suggestionId = positiveInt(id);
    if (!suggestionId) throw fail("A suggestion id is required", 400, "HR-RECRUITMENT-DUPLICATE-INPUT-INVALID");
    if (action !== "MERGE" && action !== "DISMISS") {
        throw fail("action must be MERGE or DISMISS", 400, "HR-RECRUITMENT-DUPLICATE-INPUT-INVALID");
    }
    const row = await loadSuggestion(tenantId, suggestionId);
    assertResolvable(row, expectedStatus);
    return action === "MERGE"
        ? resolveMerge({ tenantId, row, survivorId, actorId, note, keepSurvivorOnConflict })
        : resolveDismiss({ tenantId, row, actorId, note });
}
