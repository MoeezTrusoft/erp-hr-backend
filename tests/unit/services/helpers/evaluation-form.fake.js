// tests/unit/services/helpers/evaluation-form.fake.js
//
// An in-memory stand-in for the prisma models the Phase 3b evaluation-form
// services touch. It evaluates the where-clauses they build (equality,
// in/notIn/not/lt/lte/gt/gte/contains, AND/OR, relation filters with
// some/none) and projects select / include with nested relations, so access
// rules, pinning, locking and freezing are exercised against data rather than
// asserted as call shapes.
//
// Like Prisma, every query is LAZY: it runs when awaited and reads the request
// context then. A query awaited outside a tenant or SYSTEM context fails the
// way FORCE RLS would (HR-4030), and every query is recorded with the context
// it ran under (contextLog).
import { jest } from "@jest/globals";
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const TABLES = {
    interview: "interviews",
    interviewInterviewer: "interviewers",
    interviewScorecard: "scorecards",
    application: "applications",
    candidate: "candidates",
    jobRequisition: "requisitions",
    employee: "employees",
    scorecardTemplate: "templates",
    scorecardTemplateLink: "links",
    interviewQuestion: "questions",
    candidateTestResult: "testResults",
    candidateTestBlueprint: "blueprints",
    candidateEvaluationSummary: "summaries",
    outboxEvent: "outbox",
};

// relation name -> [target model, resolver(row, store)]
const RELATIONS = {
    interview: {
        application: ["application", (r, s) => s.applications.find((a) => a.id === r.applicationId) ?? null],
        interviewers: ["interviewInterviewer", (r, s) => s.interviewers.filter((i) => i.interviewId === r.id)],
        scorecards: ["interviewScorecard", (r, s) => s.scorecards.filter((c) => c.interviewId === r.id)],
    },
    application: {
        candidate: ["candidate", (r, s) => s.candidates.find((c) => c.id === r.candidateId) ?? null],
        jobRequisition: ["jobRequisition", (r, s) => s.requisitions.find((j) => j.id === r.jobRequisitionId) ?? null],
        interviews: ["interview", (r, s) => s.interviews.filter((i) => i.applicationId === r.id)],
    },
    interviewInterviewer: {
        employee: ["employee", (r, s) => s.employees.find((e) => e.id === r.employeeId) ?? null],
        interview: ["interview", (r, s) => s.interviews.find((i) => i.id === r.interviewId) ?? null],
    },
    interviewScorecard: {
        reviewer: ["employee", (r, s) => s.employees.find((e) => e.id === r.reviewerId) ?? null],
        interview: ["interview", (r, s) => s.interviews.find((i) => i.id === r.interviewId) ?? null],
    },
    scorecardTemplate: {
        links: ["scorecardTemplateLink", (r, s) => s.links.filter((l) => l.templateId === r.id)],
    },
    scorecardTemplateLink: {
        template: ["scorecardTemplate", (r, s) => s.templates.find((t) => t.id === r.templateId) ?? null],
    },
};

const num = (v) => (v instanceof Date ? v.getTime() : v);
const OPS = new Set(["in", "notIn", "lt", "lte", "gt", "gte", "not", "equals", "contains", "mode", "some", "none", "every"]);

function compare(value, op, arg, cond, model, rel, store) {
    const v = value === undefined ? null : value;
    switch (op) {
        case "in": return arg.includes(v);
        case "notIn": return !arg.includes(v);
        case "lt": return v != null && num(v) < num(arg);
        case "lte": return v != null && num(v) <= num(arg);
        case "gt": return v != null && num(v) > num(arg);
        case "gte": return v != null && num(v) >= num(arg);
        case "equals": return num(v) === num(arg);
        case "not":
            if (arg === null) return v != null;
            if (typeof arg === "object" && !(arg instanceof Date)) return !matchValue(v, arg, model, rel, store);
            return num(v) !== num(arg);
        case "contains":
            return typeof v === "string" && (cond.mode === "insensitive" ? v.toLowerCase().includes(String(arg).toLowerCase()) : v.includes(arg));
        case "mode": return true;
        case "some": return Array.isArray(v) && v.some((item) => matches(item, arg, rel, store));
        case "none": return !Array.isArray(v) || !v.some((item) => matches(item, arg, rel, store));
        case "every": return Array.isArray(v) && v.every((item) => matches(item, arg, rel, store));
        default: throw new Error(`fake prisma: unsupported operator ${op}`);
    }
}

function matchValue(value, cond, model, rel, store) {
    if (cond === null) return value == null;
    if (cond instanceof Date) return num(value) === cond.getTime();
    if (typeof cond === "object" && !Array.isArray(cond)) {
        if (Object.keys(cond).some((k) => OPS.has(k))) {
            return Object.entries(cond).every(([op, arg]) => compare(value, op, arg, cond, model, rel, store));
        }
        return value != null && matches(value, cond, rel, store);
    }
    return value === cond;
}

export function matches(row, where = {}, model, store) {
    return Object.entries(where ?? {}).every(([key, cond]) => {
        if (cond === undefined) return true;
        if (key === "OR") return cond.some((w) => matches(row, w, model, store));
        if (key === "AND") return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w, model, store));
        if (key === "NOT") return !matches(row, cond, model, store);
        const relation = RELATIONS[model]?.[key];
        if (relation) {
            const [target, resolve] = relation;
            return matchValue(resolve(row, store), cond, model, target, store);
        }
        return matchValue(row?.[key], cond, model, null, store);
    });
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function project(row, model, args, store) {
    if (!row) return null;
    const { select, include } = args ?? {};
    const scalars = () => Object.fromEntries(Object.entries(row).filter(([k]) => !RELATIONS[model]?.[k]).map(([k, v]) => [k, clone(v)]));
    const relationValue = (key, spec) => {
        const [target, resolve] = RELATIONS[model][key];
        let value = resolve(row, store);
        if (Array.isArray(value)) {
            if (spec?.where) value = value.filter((item) => matches(item, spec.where, target, store));
            return value.map((item) => project(item, target, spec === true ? {} : spec, store));
        }
        return project(value, target, spec === true ? {} : spec, store);
    };
    if (select) {
        const out = {};
        for (const [key, spec] of Object.entries(select)) {
            if (!spec) continue;
            if (key === "_count") {
                out._count = Object.fromEntries(Object.keys(spec.select ?? {}).map((k) => [k, RELATIONS[model][k][1](row, store).length]));
            } else if (RELATIONS[model]?.[key]) out[key] = relationValue(key, spec);
            else out[key] = clone(row[key]);
        }
        return out;
    }
    const out = scalars();
    for (const [key, spec] of Object.entries(include ?? {})) if (spec) out[key] = relationValue(key, spec);
    return out;
}

function sortRows(rows, orderBy) {
    const list = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o));
    if (!list.length) return rows;
    return [...rows].sort((a, b) => {
        for (const [field, dir] of list) {
            const x = num(a[field]);
            const y = num(b[field]);
            if (x === y) continue;
            const r = x == null ? -1 : y == null ? 1 : x < y ? -1 : 1;
            return dir === "desc" ? -r : r;
        }
        return 0;
    });
}

function lazyQuery(contextLog, model, op, run) {
    let promise = null;
    const execute = () => {
        if (!promise) {
            const ctx = mcpCtx.getStore();
            contextLog.push({ model, op, system: Boolean(ctx?.system), tenantId: ctx?.user?.tenantId ?? null });
            promise = ctx?.system || ctx?.user?.tenantId
                ? Promise.resolve().then(run)
                : Promise.reject(Object.assign(new Error(`RLS: ${model}.${op} ran outside a tenant context`), { code: "HR-4030" }));
        }
        return promise;
    };
    return {
        then: (onOk, onErr) => execute().then(onOk, onErr),
        catch: (onErr) => execute().catch(onErr),
        finally: (fn) => execute().finally(fn),
    };
}

const UNIQUE = {
    interviewScorecard: (a, b) => a.interviewId === b.interviewId && a.reviewerId === b.reviewerId,
    candidateEvaluationSummary: (a, b) => a.interviewId === b.interviewId,
    interviewQuestion: (a, b) => a.tenantId === b.tenantId && a.questionKey === b.questionKey && a.version === b.version,
};

const DEFAULTS = {
    interviewScorecard: () => ({ status: "DRAFT", mustHaveFailed: false, coiDeclared: false, notesFlagged: false, notesFlagTerms: [], criterionScores: null, weightedScore: null, submittedAt: null, startedAt: null, draftSavedAt: null, amendmentLog: null, lastAmendedAt: null, templateId: null, templateVersion: null, recommendation: null, notes: null, overallScore: null }),
    scorecardTemplate: () => ({ isActive: true, status: "PUBLISHED", version: 1, templateKey: null, interviewType: null, panelRole: null, scale: null, sections: null, evidenceRules: null, requiresTrainedInterviewer: false, publishedAt: null, description: null }),
    scorecardTemplateLink: () => ({ isActive: true, scopeId: null, scopeKey: null }),
    interviewQuestion: () => ({ status: "DRAFT", version: 1, followUps: null, goodAnswerGuide: null, level: null, aiDrafted: false }),
    candidateEvaluationSummary: () => ({ pdfMediaId: null, frozenById: null, rankAtSnapshot: null }),
};

export function createFakeDb() {
    const store = Object.fromEntries(Object.values(TABLES).map((t) => [t, []]));
    let nextId = 1000;
    const contextLog = [];

    const modelOps = (model) => {
        const rows = () => store[TABLES[model]];
        const find = (where) => rows().filter((r) => matches(r, where, model, store));
        const insert = (data) => {
            const now = new Date();
            const row = { id: nextId++, createdAt: now, updatedAt: now, ...(DEFAULTS[model]?.() ?? {}), ...clone(data) };
            if (UNIQUE[model] && rows().some((r) => UNIQUE[model](r, row))) {
                throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
            }
            rows().push(row);
            return row;
        };
        return {
            findFirst: (args = {}) => project(sortRows(find(args.where), args.orderBy)[0] ?? null, model, args, store),
            findUnique: (args = {}) => {
                const where = { ...args.where };
                for (const [k, v] of Object.entries(where)) {
                    if (k.includes("_") && v && typeof v === "object") {
                        delete where[k];
                        Object.assign(where, v);
                    }
                }
                return project(find(where)[0] ?? null, model, args, store);
            },
            findMany: (args = {}) => {
                let list = sortRows(find(args.where), args.orderBy);
                list = list.slice(args.skip ?? 0, args.take != null ? (args.skip ?? 0) + args.take : undefined);
                return list.map((r) => project(r, model, args, store));
            },
            count: (args = {}) => find(args.where).length,
            create: (args) => project(insert(args.data), model, args, store),
            createMany: ({ data, skipDuplicates }) => {
                let count = 0;
                for (const item of data) {
                    try {
                        insert(item);
                        count += 1;
                    } catch (err) {
                        if (!(skipDuplicates && err.code === "P2002")) throw err;
                    }
                }
                return { count };
            },
            update: (args) => {
                const row = find(args.where)[0];
                if (!row) throw Object.assign(new Error("Record to update not found"), { code: "P2025" });
                Object.assign(row, clone(args.data), { updatedAt: new Date() });
                return project(row, model, args, store);
            },
            updateMany: ({ where, data }) => {
                const hit = find(where);
                for (const row of hit) Object.assign(row, clone(data), { updatedAt: new Date() });
                return { count: hit.length };
            },
            upsert: (args) => {
                const where = { ...args.where };
                for (const [k, v] of Object.entries(where)) {
                    if (k.includes("_") && v && typeof v === "object") {
                        delete where[k];
                        Object.assign(where, v);
                    }
                }
                const row = find(where)[0];
                if (row) {
                    Object.assign(row, clone(args.update));
                    return project(row, model, args, store);
                }
                return project(insert(args.create), model, args, store);
            },
            delete: (args) => {
                const row = find(args.where)[0];
                store[TABLES[model]] = rows().filter((r) => r !== row);
                return row;
            },
            deleteMany: ({ where }) => {
                const before = rows().length;
                store[TABLES[model]] = rows().filter((r) => !matches(r, where, model, store));
                return { count: before - store[TABLES[model]].length };
            },
        };
    };

    const db = { contextLog };
    for (const model of Object.keys(TABLES)) {
        const ops = modelOps(model);
        db[model] = Object.fromEntries(
            Object.entries(ops).map(([op, impl]) => [op, jest.fn((args) => lazyQuery(contextLog, model, op, () => impl(args)))]),
        );
    }
    db.$executeRaw = jest.fn(async () => 1);
    db.$transaction = jest.fn(async (arg) => (typeof arg === "function" ? arg(db) : Promise.all(arg)));
    db.nextId = () => nextId++;
    return { db, store };
}
