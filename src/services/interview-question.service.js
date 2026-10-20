// src/services/interview-question.service.js
//
// Recruitment Phase 3b — the interview question bank (plan 7.4.1: "Suggested
// questions, linked from the interview question bank, with follow-ups and a
// what-good-looks-like guide").
//
// The rules:
//   * Versions share a questionKey, like the item bank and the form
//     templates. A DRAFT changes in place; a PUBLISHED version is immutable,
//     so editing it creates the next version (DRAFT unless published at once).
//   * Forms link questions by key and always show the latest PUBLISHED
//     version; retiring a question retires every version of its key, so an
//     older published version cannot resurface.
//   * Tenant-scoped (withTenant) on every query; HR and recruiters manage the
//     bank (checked by the tools), interviewers read it through their form.
import crypto from "node:crypto";

import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { withTenant } from "../lib/tenancy.js";
import { TEMPLATE_STATUS } from "../lib/evaluation-form.util.js";

export const QUESTION_LEVELS = Object.freeze(["JUNIOR", "MID", "SENIOR"]);
export const QUESTION_STATUSES = Object.freeze(Object.values(TEMPLATE_STATUS));

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const text = (v, max = 4000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

const QUESTION_SELECT = Object.freeze({
    id: true,
    questionKey: true,
    version: true,
    status: true,
    competencyKey: true,
    prompt: true,
    followUps: true,
    goodAnswerGuide: true,
    level: true,
    aiDrafted: true,
    createdById: true,
    createdAt: true,
    updatedAt: true,
});

const slug = (value) =>
    String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "q";

const followUpsOf = (raw) => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) throw fail("followUps must be a list of prompts", 400, "HR-RECRUITMENT-QUESTION-INVALID");
    return raw.map((f) => text(f, 1000)).filter(Boolean).slice(0, 10);
};

const levelOf = (raw) => {
    if (raw === undefined) return undefined;
    if (raw === null || raw === "") return null;
    const v = String(raw).toUpperCase();
    if (!QUESTION_LEVELS.includes(v)) throw fail(`level must be one of ${QUESTION_LEVELS.join(", ")}`, 400, "HR-RECRUITMENT-QUESTION-INVALID");
    return v;
};

/** Keep only the highest version of each key. */
export function latestByKey(rows = []) {
    const best = new Map();
    for (const row of rows) {
        const seen = best.get(row.questionKey);
        if (!seen || row.version > seen.version) best.set(row.questionKey, row);
    }
    return [...best.values()];
}

/**
 * List the bank. latestOnly (default) keeps the highest version of each key
 * among the rows that match the filters.
 */
export async function listQuestions({ tenantId, competencyKey, status, level, q, latestOnly = true, page = 1, limit = DEFAULT_LIMIT } = {}) {
    const where = withTenant(tenantId, {});
    if (competencyKey) where.competencyKey = String(competencyKey);
    if (status) {
        const s = String(status).toUpperCase();
        if (!QUESTION_STATUSES.includes(s)) throw fail(`status must be one of ${QUESTION_STATUSES.join(", ")}`, 400, "HR-RECRUITMENT-QUESTION-INVALID");
        where.status = s;
    }
    if (level) where.level = levelOf(level);
    if (q && String(q).trim()) where.prompt = { contains: String(q).trim(), mode: "insensitive" };
    const rows = await prisma.interviewQuestion.findMany({
        where,
        select: QUESTION_SELECT,
        orderBy: [{ questionKey: "asc" }, { version: "desc" }],
        take: 2000,
    });
    const list = latestOnly ? latestByKey(rows) : rows;
    const size = Math.min(positiveInt(limit) ?? DEFAULT_LIMIT, MAX_LIMIT);
    const p = positiveInt(page) ?? 1;
    return { items: list.slice((p - 1) * size, p * size), total: list.length, page: p, limit: size };
}

/**
 * Create a question (DRAFT, or PUBLISHED with publish true). A new key is
 * minted from the competency unless one is given; a key that exists is a 409.
 */
export async function createQuestion({ tenantId, actorId = null, competencyKey, prompt, followUps, goodAnswerGuide, level, questionKey, publish = false, aiDrafted = false } = {}) {
    const competency = text(competencyKey, 100);
    const body = text(prompt);
    if (!competency || !body) throw fail("A question needs a competencyKey and a prompt", 400, "HR-RECRUITMENT-QUESTION-INVALID");
    let key = text(questionKey, 80);
    if (key) {
        const clash = await prisma.interviewQuestion.findFirst({ where: withTenant(tenantId, { questionKey: key }), select: { id: true } });
        if (clash) throw fail("A question with this key exists; update it to make a new version", 409, "HR-RECRUITMENT-QUESTION-KEY-EXISTS");
    } else {
        key = `${slug(competency)}-${crypto.randomBytes(3).toString("hex")}`;
    }
    const row = await prisma.interviewQuestion.create({
        data: withTenant(tenantId, {
            questionKey: key,
            version: 1,
            status: publish ? TEMPLATE_STATUS.PUBLISHED : TEMPLATE_STATUS.DRAFT,
            competencyKey: competency,
            prompt: body,
            followUps: followUpsOf(followUps ?? []),
            goodAnswerGuide: text(goodAnswerGuide),
            level: levelOf(level) ?? null,
            aiDrafted: aiDrafted === true,
            createdById: positiveInt(actorId),
        }),
        select: QUESTION_SELECT,
    });
    logger.info({ tenantId, questionId: row.id, questionKey: key }, "interview question created");
    return row;
}

/**
 * Update a question. A DRAFT changes in place (status PUBLISHED publishes it);
 * a PUBLISHED version is immutable, so a change creates version n+1. A
 * RETIRED question cannot change.
 */
export async function updateQuestion({ tenantId, actorId = null, questionId, competencyKey, prompt, followUps, goodAnswerGuide, level, status } = {}) {
    const id = positiveInt(questionId);
    const existing = id
        ? await prisma.interviewQuestion.findFirst({ where: withTenant(tenantId, { id }), select: QUESTION_SELECT })
        : null;
    if (!existing) throw fail("Question not found", 404, "HR-RECRUITMENT-QUESTION-NOT-FOUND");
    if (existing.status === TEMPLATE_STATUS.RETIRED) throw fail("A retired question cannot change", 409, "HR-RECRUITMENT-QUESTION-RETIRED");
    const nextStatus = status === undefined ? undefined : String(status).toUpperCase();
    if (nextStatus !== undefined && nextStatus !== TEMPLATE_STATUS.DRAFT && nextStatus !== TEMPLATE_STATUS.PUBLISHED) {
        throw fail("status must be DRAFT or PUBLISHED (use retire to retire)", 400, "HR-RECRUITMENT-QUESTION-INVALID");
    }

    const changes = {};
    if (competencyKey !== undefined) changes.competencyKey = text(competencyKey, 100);
    if (prompt !== undefined) changes.prompt = text(prompt);
    if (followUps !== undefined) changes.followUps = followUpsOf(followUps);
    if (goodAnswerGuide !== undefined) changes.goodAnswerGuide = text(goodAnswerGuide);
    if (level !== undefined) changes.level = levelOf(level);
    if (changes.competencyKey === null || changes.prompt === null) {
        throw fail("A question needs a competencyKey and a prompt", 400, "HR-RECRUITMENT-QUESTION-INVALID");
    }
    const changed = Object.entries(changes).some(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(existing[k] ?? null));

    if (existing.status === TEMPLATE_STATUS.DRAFT) {
        return prisma.interviewQuestion.update({
            where: { id: existing.id },
            data: { ...changes, ...(nextStatus ? { status: nextStatus } : {}) },
            select: QUESTION_SELECT,
        });
    }
    // PUBLISHED: unchanged is a no-op; a change is the next version.
    if (!changed) return existing;
    const latest = await prisma.interviewQuestion.findFirst({
        where: withTenant(tenantId, { questionKey: existing.questionKey }),
        orderBy: { version: "desc" },
        select: { version: true },
    });
    const row = await prisma.interviewQuestion.create({
        data: withTenant(tenantId, {
            questionKey: existing.questionKey,
            version: Math.max(latest?.version ?? 1, existing.version) + 1,
            status: nextStatus ?? TEMPLATE_STATUS.DRAFT,
            competencyKey: existing.competencyKey,
            prompt: existing.prompt,
            followUps: existing.followUps ?? [],
            goodAnswerGuide: existing.goodAnswerGuide ?? null,
            level: existing.level ?? null,
            ...changes,
            aiDrafted: false,
            createdById: positiveInt(actorId),
        }),
        select: QUESTION_SELECT,
    });
    return { ...row, newVersion: true, previousVersionId: existing.id };
}

/** Retire every version of the question's key. */
export async function retireQuestion({ tenantId, questionId } = {}) {
    const id = positiveInt(questionId);
    const existing = id
        ? await prisma.interviewQuestion.findFirst({ where: withTenant(tenantId, { id }), select: { id: true, questionKey: true } })
        : null;
    if (!existing) throw fail("Question not found", 404, "HR-RECRUITMENT-QUESTION-NOT-FOUND");
    const res = await prisma.interviewQuestion.updateMany({
        where: withTenant(tenantId, { questionKey: existing.questionKey, status: { not: TEMPLATE_STATUS.RETIRED } }),
        data: { status: TEMPLATE_STATUS.RETIRED },
    });
    return { questionKey: existing.questionKey, retiredVersions: res.count };
}

/**
 * The latest PUBLISHED questions for a form: by linked key, and up to
 * `perCompetency` per competency (for test-informed probes). Runs on the given
 * client so a caller inside a transaction stays inside it.
 *
 * @returns {Promise<{ byKey: Record<string, object>, byCompetency: Record<string, object[]> }>}
 */
export async function publishedQuestionsFor(client, tenantId, { keys = [], competencyKeys = [], perCompetency = 3 } = {}) {
    const or = [];
    if (keys.length) or.push({ questionKey: { in: keys } });
    if (competencyKeys.length) or.push({ competencyKey: { in: competencyKeys } });
    if (!or.length) return { byKey: {}, byCompetency: {} };
    const rows = await client.interviewQuestion.findMany({
        where: withTenant(tenantId, { status: TEMPLATE_STATUS.PUBLISHED, OR: or }),
        select: QUESTION_SELECT,
        orderBy: [{ questionKey: "asc" }, { version: "desc" }],
        take: 1000,
    });
    const latest = latestByKey(rows);
    const byKey = Object.fromEntries(latest.filter((r) => keys.includes(r.questionKey)).map((r) => [r.questionKey, r]));
    const byCompetency = {};
    for (const row of latest) {
        if (!competencyKeys.includes(row.competencyKey)) continue;
        const list = (byCompetency[row.competencyKey] ??= []);
        if (list.length < perCompetency) list.push(row);
    }
    return { byKey, byCompetency };
}
