// tests/unit/services/candidate-communication.fakes.js
//
// An in-memory stand-in for the prisma models the candidate communication
// modules touch. It evaluates the Prisma where-clauses those modules build
// (equality, in/notIn/lt/lte/gt/not, OR/AND, relation filters and `some`), so
// the claim, dedupe and cancel conditions are exercised for real rather than
// asserted as call shapes.
//
// Like Prisma, every query is LAZY: it runs when awaited, and it reads the
// request context at that moment. A query awaited outside mcpCtx fails the way
// FORCE RLS would (HR-4030), and every executed query is recorded with the
// context it ran under (`contextLog`), so tests catch a query that escapes the
// tenant or SYSTEM context it was built in.
import { jest } from "@jest/globals";
import { mcpCtx } from "../../../src/lib/requestContext.js";

const OPS = new Set(["in", "notIn", "lt", "lte", "gt", "gte", "not", "equals", "some", "none"]);
const num = (v) => (v instanceof Date ? v.getTime() : v);

function compare(value, op, arg) {
    const v = value === undefined ? null : value;
    switch (op) {
        case "in":
            return arg.includes(v);
        case "notIn":
            return !arg.includes(v);
        case "lt":
            return v != null && num(v) < num(arg);
        case "lte":
            return v != null && num(v) <= num(arg);
        case "gt":
            return v != null && num(v) > num(arg);
        case "gte":
            return v != null && num(v) >= num(arg);
        case "not":
            return arg === null ? v != null : v !== arg;
        case "equals":
            return v === arg;
        case "some":
            return Array.isArray(v) && v.some((item) => matches(item, arg));
        case "none":
            return !Array.isArray(v) || !v.some((item) => matches(item, arg));
        default:
            throw new Error(`fake prisma: unsupported operator ${op}`);
    }
}

export function matches(row, where = {}) {
    return Object.entries(where ?? {}).every(([key, cond]) => {
        if (key === "OR") return cond.some((w) => matches(row, w));
        if (key === "AND") return cond.every((w) => matches(row, w));
        const value = row?.[key];
        if (cond === null) return value == null;
        if (cond instanceof Date) return num(value) === cond.getTime();
        if (typeof cond === "object" && !Array.isArray(cond)) {
            if (Object.keys(cond).some((k) => OPS.has(k))) {
                return Object.entries(cond).every(([op, arg]) => compare(value, op, arg));
            }
            return value != null && matches(value, cond);
        }
        return value === cond;
    });
}

const clone = (row) => (row ? structuredClone(row) : null);

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

// Wrap each model method so it returns a lazy query (still a jest.fn, so a
// test can override it with mockRejectedValue and friends).
function lazyModel(contextLog, model, methods) {
    return Object.fromEntries(
        Object.entries(methods).map(([op, impl]) => [op, jest.fn((args) => lazyQuery(contextLog, model, op, () => impl(args)))]),
    );
}

export function createFakeDb() {
    const store = {
        communications: [],
        applications: [],
        candidates: [],
        interviews: [],
        offers: [],
        history: [],
        // Phase 7 — the nurture invitation an accepted application came from.
        invitations: [],
    };
    let nextId = 1;

    const contextLog = [];
    const finder = (rows) => ({
        findFirst: ({ where } = {}) => clone(rows().find((r) => matches(r, where)) ?? null),
        findMany: ({ where, take, skip = 0, orderBy } = {}) => {
            let list = rows().filter((r) => matches(r, where));
            if (orderBy && !Array.isArray(orderBy) && orderBy.id === "asc") list = [...list].sort((a, b) => a.id - b.id);
            if (Array.isArray(orderBy) && orderBy[0]?.createdAt === "desc") list = [...list].sort((a, b) => b.id - a.id);
            list = list.slice(skip, take != null ? skip + take : undefined);
            return list.map(clone);
        },
        count: ({ where } = {}) => rows().filter((r) => matches(r, where)).length,
    });

    const uniqueClash = (data) =>
        store.communications.some((r) => r.tenantId === data.tenantId && r.dedupeKey === data.dedupeKey);
    const insert = (data) => {
        const now = new Date();
        const row = {
            id: nextId++,
            attempts: 0,
            channel: "email",
            status: "QUEUED",
            suppressedReason: null,
            nextAttemptAt: null,
            lastError: null,
            claimedBy: null,
            claimExpiresAt: null,
            sentAt: null,
            createdAt: now,
            updatedAt: now,
            ...structuredClone(data),
        };
        store.communications.push(row);
        return row;
    };

    const db = {
        candidateCommunication: lazyModel(contextLog, "candidateCommunication", {
            ...finder(() => store.communications),
            createMany: ({ data, skipDuplicates }) => {
                let count = 0;
                for (const item of data) {
                    if (uniqueClash(item)) {
                        if (skipDuplicates) continue;
                        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                    }
                    insert(item);
                    count += 1;
                }
                return { count };
            },
            create: ({ data }) => {
                if (uniqueClash(data)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                return clone(insert(data));
            },
            updateMany: ({ where, data }) => {
                const hit = store.communications.filter((r) => matches(r, where));
                for (const row of hit) Object.assign(row, structuredClone(data), { updatedAt: new Date() });
                return { count: hit.length };
            },
        }),
        application: lazyModel(contextLog, "application", finder(() => store.applications)),
        candidate: lazyModel(contextLog, "candidate", finder(() => store.candidates)),
        interview: lazyModel(contextLog, "interview", finder(() => store.interviews)),
        offer: lazyModel(contextLog, "offer", finder(() => store.offers)),
        applicationStageHistory: lazyModel(contextLog, "applicationStageHistory", finder(() => store.history)),
        talentPoolInvitation: lazyModel(contextLog, "talentPoolInvitation", finder(() => store.invitations)),
        $executeRaw: jest.fn(async () => 1),
        contextLog,
    };
    db.$transaction = jest.fn(async (arg) => (typeof arg === "function" ? arg(db) : Promise.all(arg)));
    return { db, store };
}

// A pino-shaped logger whose calls (including children's) land in one list,
// so a test can assert what was — and was not — logged.
export function createRecordingLogger() {
    const calls = [];
    const make = (bindings = {}) => {
        const log = {};
        for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
            log[level] = jest.fn((...args) => calls.push({ level, bindings, args }));
        }
        log.child = jest.fn((more) => make({ ...bindings, ...more }));
        return log;
    };
    return { logger: make(), calls };
}
