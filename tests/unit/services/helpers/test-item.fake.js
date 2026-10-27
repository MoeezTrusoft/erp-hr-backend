// tests/unit/services/helpers/test-item.fake.js
//
// An in-memory stand-in for the Prisma models the Phase 3b item bank touches:
// candidate test items, their statistics, responses and results, skills,
// grade levels and requisitions. It evaluates the where-clauses the code
// builds (equality, in / not / lt / lte / gt / gte / contains / has, OR /
// AND), projects `select`, applies orderBy / skip / take, enforces the
// (tenantId, itemCode, version) and (itemId, period) unique keys and the
// four-eyes CHECK, and rolls a failed $transaction back.
//
// Like Prisma, every query is LAZY: it runs when awaited and reads the request
// context at that moment, so a query that escapes its mcpCtx.run or
// tenantTransaction fails (HR-4030) the way FORCE RLS would. A tenant context
// sees its own rows (plus platform rows, tenantId null, for skills); SYSTEM
// sees all. Every executed query is logged with its context.
import { jest } from "@jest/globals";
import { Prisma } from "@prisma/client";
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const OPS = new Set(["in", "notIn", "lt", "lte", "gt", "gte", "not", "equals", "contains", "mode", "has"]);
const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const num = (v) => (isDate(v) ? v.getTime() : v);

function compare(value, op, arg, cond) {
    const v = value === undefined ? null : value;
    switch (op) {
        case "in": return arg.map(num).includes(num(v));
        case "notIn": return !arg.map(num).includes(num(v));
        case "lt": return v != null && num(v) < num(arg);
        case "lte": return v != null && num(v) <= num(arg);
        case "gt": return v != null && num(v) > num(arg);
        case "gte": return v != null && num(v) >= num(arg);
        case "not": return arg === null ? v != null : num(v) !== num(arg);
        case "equals": return num(v) === num(arg);
        case "has": return Array.isArray(v) && v.includes(arg);
        case "mode": return true;
        case "contains":
            return cond.mode === "insensitive"
                ? String(v ?? "").toLowerCase().includes(String(arg).toLowerCase())
                : String(v ?? "").includes(String(arg));
        default: throw new Error(`fake prisma: unsupported operator ${op}`);
    }
}

export function matches(row, where = {}) {
    return Object.entries(where ?? {}).every(([key, cond]) => {
        if (cond === undefined) return true;
        if (key === "OR") return cond.some((w) => matches(row, w));
        if (key === "AND") return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w));
        const value = row?.[key];
        if (cond === null) return value == null;
        if (isDate(cond)) return num(value) === cond.getTime();
        if (typeof cond === "object" && !Array.isArray(cond)) {
            if (Object.keys(cond).some((k) => OPS.has(k))) {
                return Object.entries(cond).every(([op, arg]) => compare(value, op, arg, cond));
            }
            return value != null && matches(value, cond);
        }
        return num(value) === num(cond);
    });
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function project(row, select) {
    if (!row) return null;
    if (!select) return clone(row);
    const out = {};
    for (const [key, sel] of Object.entries(select)) if (sel) out[key] = clone(row[key]);
    return out;
}

function applyData(row, data) {
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        if (value === Prisma.DbNull || value === Prisma.JsonNull) row[key] = null;
        else if (value && typeof value === "object" && !isDate(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
        else row[key] = isDate(value) ? new Date(value.getTime()) : clone(value);
    }
}

const ITEM_DEFAULTS = () => ({
    version: 1, status: "DRAFT", mediaId: null, options: null, scoringRule: null, skillId: null, jobFamily: null,
    gradeLevelIds: [], language: "en", timeEstimateSec: null, rationale: null, discussionPrompt: false, aiDrafted: false,
    authorId: null, reviewerId: null, reviewComment: null, submittedAt: null, publishedAt: null, retiredAt: null,
    exposureCount: 0, exposureCap: null,
});

export function createTestItemDb() {
    const state = { items: [], stats: [], responses: [], results: [], skills: [], grades: [], requisitions: [], employees: [] };
    const contextLog = [];
    let nextId = 100;
    const platformTables = new Set(["skills"]);

    // Employees carry their tenant as tenant_id (Phase 7 name lookups).
    const tenantOf = (table, r) => (table === "employees" ? r.tenant_id : r.tenantId);

    function visible(table, ctx) {
        if (ctx?.system) return state[table];
        return state[table].filter((r) => tenantOf(table, r) === ctx.user.tenantId || (platformTables.has(table) && r.tenantId == null));
    }

    function lazy(model, op, run) {
        let promise = null;
        const execute = () => {
            if (!promise) {
                const ctx = mcpCtx.getStore();
                contextLog.push({ model, op, system: Boolean(ctx?.system), tenantId: ctx?.user?.tenantId ?? null });
                promise = ctx?.system || ctx?.user?.tenantId
                    ? Promise.resolve().then(() => run(ctx))
                    : Promise.reject(Object.assign(new Error(`RLS: ${model}.${op} ran outside a tenant context`), { code: "HR-4030" }));
            }
            return promise;
        };
        return { then: (ok, err) => execute().then(ok, err), catch: (err) => execute().catch(err), finally: (fn) => execute().finally(fn) };
    }

    const sortRows = (rows, orderBy) => {
        const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        if (!list.length) return [...rows];
        return [...rows].sort((a, b) => {
            for (const o of list) {
                const [key, dir] = Object.entries(o)[0];
                const av = num(a[key]);
                const bv = num(b[key]);
                if (av === bv) continue;
                return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
            }
            return 0;
        });
    };

    const assertWritable = (ctx, data) => {
        if (!ctx.system && data.tenantId !== ctx.user.tenantId) {
            throw Object.assign(new Error("RLS: write for another tenant"), { code: "42501" });
        }
    };

    const checks = {
        items: (row) => {
            if (row.reviewerId != null && row.authorId != null && row.reviewerId === row.authorId) {
                throw Object.assign(new Error("new row violates check constraint candidate_test_items_four_eyes_check"), { code: "23514" });
            }
            const clash = state.items.find((o) => o !== row && o.tenantId === row.tenantId && o.itemCode === row.itemCode && o.version === row.version);
            if (clash) throw Object.assign(new Error("Unique constraint failed on (tenantId, itemCode, version)"), { code: "P2002" });
        },
        stats: (row) => {
            if (state.stats.find((o) => o !== row && o.itemId === row.itemId && o.period === row.period)) {
                throw Object.assign(new Error("Unique constraint failed on (itemId, period)"), { code: "P2002" });
            }
        },
    };

    function model(name, table, defaults = () => ({})) {
        const ops = {
            findFirst: (args = {}) => lazy(name, "findFirst", (ctx) =>
                project(sortRows(visible(table, ctx), args.orderBy).find((r) => matches(r, args.where)), args.select)),
            findMany: (args = {}) => lazy(name, "findMany", (ctx) => {
                let rows = sortRows(visible(table, ctx).filter((r) => matches(r, args.where)), args.orderBy);
                rows = rows.slice(args.skip ?? 0, args.take != null ? (args.skip ?? 0) + args.take : undefined);
                return rows.map((r) => project(r, args.select));
            }),
            count: (args = {}) => lazy(name, "count", (ctx) => visible(table, ctx).filter((r) => matches(r, args.where)).length),
            create: (args = {}) => lazy(name, "create", (ctx) => {
                assertWritable(ctx, args.data);
                const now = new Date();
                const row = { id: nextId++, ...defaults(), createdAt: now, updatedAt: now };
                applyData(row, args.data);
                checks[table]?.(row);
                state[table].push(row);
                return project(row, args.select);
            }),
            updateMany: (args = {}) => lazy(name, "updateMany", (ctx) => {
                const hit = visible(table, ctx).filter((r) => matches(r, args.where));
                for (const row of hit) {
                    const before = structuredClone(row);
                    applyData(row, { ...args.data, updatedAt: new Date() });
                    try {
                        checks[table]?.(row);
                    } catch (err) {
                        Object.assign(row, before);
                        throw err;
                    }
                }
                return { count: hit.length };
            }),
            upsert: (args = {}) => lazy(name, "upsert", (ctx) => {
                const key = Object.values(args.where)[0];
                const existing = visible(table, ctx).find((r) => matches(r, key));
                if (existing) {
                    applyData(existing, args.update);
                    return project(existing, args.select);
                }
                assertWritable(ctx, args.create);
                const row = { id: nextId++, ...defaults(), computedAt: new Date() };
                applyData(row, args.create);
                checks[table]?.(row);
                state[table].push(row);
                return project(row, args.select);
            }),
        };
        return Object.fromEntries(Object.entries(ops).map(([op, impl]) => [op, jest.fn(impl)]));
    }

    const db = {
        candidateTestItem: model("candidateTestItem", "items", ITEM_DEFAULTS),
        candidateTestItemStat: model("candidateTestItemStat", "stats", () => ({ flags: [], distractorRates: null })),
        candidateTestResponse: model("candidateTestResponse", "responses"),
        candidateTestResult: model("candidateTestResult", "results"),
        skill: model("skill", "skills"),
        gradeLevel: model("gradeLevel", "grades"),
        jobRequisition: model("jobRequisition", "requisitions"),
        employee: model("employee", "employees"),
        $executeRaw: jest.fn(async () => 1),
        contextLog,
    };
    let active = 0;
    db.$transaction = jest.fn(async (fn) => {
        const snapshot = structuredClone(state);
        active += 1;
        try {
            return await fn(db);
        } catch (err) {
            if (active === 1) for (const key of Object.keys(state)) state[key] = snapshot[key];
            throw err;
        } finally {
            active -= 1;
        }
    });
    return { db, state };
}

/** The outbox writer, mocked: records each event. */
export function createEventRecorder() {
    const events = [];
    const enqueueHrDomainEvent = jest.fn(async (_tx, args) => {
        if (!args?.tenantId) return null;
        events.push(structuredClone(args));
        return { id: events.length };
    });
    return { events, enqueueHrDomainEvent };
}
