// tests/unit/services/helpers/test-blueprint.fake.js
//
// An in-memory stand-in for the Prisma models the Phase 3b blueprint,
// workstation and scheduling-hook code touches: test blueprints and their
// links, test items, results, requisitions (with their position), grade
// levels, applications, interviews and kiosk workstations. It evaluates the
// where-clauses that code builds (equality, in / not / lt / lte / gt / gte,
// equals with mode "insensitive", OR / AND, `some` on blueprint links and the
// to-one link -> blueprint filter), projects `select` / `include`, applies
// `{ increment }`, enforces the unique keys the code relies on, and rolls a
// failed $transaction back.
//
// Kept from the real client, as in the other fakes:
//   * queries are LAZY and read the request context when awaited, so a query
//     that escapes its mcpCtx.run / tenantTransaction fails (HR-4030) and
//     every executed query is logged with the context it ran in;
//   * a tenant context sees only its own tenant's rows (RLS); SYSTEM sees all.
import { jest } from "@jest/globals";
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const num = (v) => (isDate(v) ? v.getTime() : v);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const OPS = new Set(["in", "not", "lt", "lte", "gt", "gte", "equals", "mode", "some"]);

function compare(value, op, arg, cond) {
    const v = value === undefined ? null : value;
    switch (op) {
        case "in": return arg.map(num).includes(num(v));
        case "not": return arg === null ? v != null : num(v) !== num(arg);
        case "lt": return v != null && num(v) < num(arg);
        case "lte": return v != null && num(v) <= num(arg);
        case "gt": return v != null && num(v) > num(arg);
        case "gte": return v != null && num(v) >= num(arg);
        case "equals":
            if (cond.mode === "insensitive") return v != null && String(v).toLowerCase() === String(arg).toLowerCase();
            return num(v) === num(arg);
        case "mode": return true;
        case "some": return Array.isArray(v) && v.some((item) => matches(item, arg));
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

function project(row, shape) {
    if (row == null) return row;
    if (Array.isArray(row)) return row.map((r) => project(r, shape));
    const out = {};
    for (const [key, sel] of Object.entries(shape)) {
        if (!sel) continue;
        if (sel === true) out[key] = clone(row[key]);
        else if (sel.select) out[key] = project(row[key], sel.select);
        else out[key] = clone(row[key]);
    }
    return out;
}

function applyData(row, data) {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && !isDate(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
        else row[key] = isDate(value) ? new Date(value.getTime()) : clone(value);
    }
}

const sortRows = (rows, orderBy) => {
    const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    if (!list.length) return rows;
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

// Unique keys the code relies on (P2002 on a clash).
const UNIQUE = {
    blueprints: [(r) => `${r.tenantId}|${r.blueprintKey}|${r.version}`],
    links: [(r) => (r.isActive ? `${r.tenantId}|${r.scopeType}|${r.scopeId ?? 0}|${r.scopeKey ?? ""}` : null)],
    workstations: [(r) => r.deviceTokenHash],
};

export function createBlueprintDb() {
    const state = {
        blueprints: [],
        links: [],
        items: [],
        results: [],
        requisitions: [],
        gradeLevels: [],
        applications: [],
        interviews: [],
        interviewers: [],
        leave: [],
        workstations: [],
    };
    const contextLog = [];
    let nextId = 1000;

    const hydrate = {
        blueprints: (b) => ({ ...b, links: state.links.filter((l) => l.blueprintId === b.id).map((l) => ({ ...l })) }),
        links: (l) => ({ ...l, blueprint: state.blueprints.find((b) => b.id === l.blueprintId) ?? null }),
        interviews: (i) => ({ ...i, interviewers: state.interviewers.filter((x) => x.interviewId === i.id) }),
    };
    const RELATIONS = new Set(["links", "blueprint", "interviewers"]);

    function visible(table, ctx) {
        const rows = state[table].map((r) => (hydrate[table] ? hydrate[table](r) : { ...r }));
        if (ctx?.system) return rows;
        return rows.filter((r) => r.tenantId === ctx.user.tenantId);
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
        return { then: (ok, err) => execute().then(ok, err), catch: (err) => execute().catch(err) };
    }

    function shape(row, args) {
        if (!row) return null;
        if (args?.select) return project(row, args.select);
        const out = {};
        for (const [k, v] of Object.entries(row)) if (!RELATIONS.has(k)) out[k] = clone(v);
        for (const [k, inc] of Object.entries(args?.include ?? {})) {
            if (!inc) continue;
            let value = row[k];
            if (Array.isArray(value) && inc.where) value = value.filter((x) => matches(x, inc.where));
            if (Array.isArray(value) && inc.orderBy) value = sortRows(value, inc.orderBy);
            out[k] = inc.select ? project(value, inc.select) : clone(value);
        }
        return out;
    }

    const conflict = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    function assertUnique(table) {
        for (const keyOf of UNIQUE[table] ?? []) {
            const keys = state[table].map(keyOf).filter((k) => k != null);
            if (new Set(keys).size !== keys.length) throw conflict();
        }
    }

    const assertWritable = (table, ctx, data) => {
        if (!ctx.system && data.tenantId !== ctx.user.tenantId) {
            throw Object.assign(new Error(`RLS: ${table} write for another tenant`), { code: "42501" });
        }
    };

    function model(name, table, { defaults = () => ({}) } = {}) {
        const ops = {
            findFirst: (args = {}) => lazy(name, "findFirst", (ctx) =>
                shape(sortRows(visible(table, ctx), args.orderBy).find((r) => matches(r, args.where)), args)),
            findUnique: (args = {}) => lazy(name, "findUnique", (ctx) => shape(visible(table, ctx).find((r) => matches(r, args.where)), args)),
            findMany: (args = {}) => lazy(name, "findMany", (ctx) => {
                let rows = sortRows(visible(table, ctx).filter((r) => matches(r, args.where)), args.orderBy);
                rows = rows.slice(args.skip ?? 0, args.take != null ? (args.skip ?? 0) + args.take : undefined);
                return rows.map((r) => shape(r, args));
            }),
            count: (args = {}) => lazy(name, "count", (ctx) => visible(table, ctx).filter((r) => matches(r, args.where)).length),
            updateMany: (args = {}) => lazy(name, "updateMany", (ctx) => {
                const ids = new Set(visible(table, ctx).filter((r) => matches(r, args.where)).map((r) => r.id));
                const before = structuredClone(state[table]);
                const hit = state[table].filter((r) => ids.has(r.id));
                for (const row of hit) applyData(row, { ...args.data, updatedAt: new Date(Date.now() + nextId++) });
                try {
                    assertUnique(table);
                } catch (err) {
                    state[table] = before;
                    throw err;
                }
                return { count: hit.length };
            }),
            create: (args = {}) => lazy(name, "create", (ctx) => {
                const { interviewers, ...data } = args.data;
                assertWritable(table, ctx, data);
                const now = new Date();
                const row = { id: nextId++, ...defaults(), createdAt: now, updatedAt: now };
                applyData(row, data);
                state[table].push(row);
                try {
                    assertUnique(table);
                } catch (err) {
                    state[table].pop();
                    throw err;
                }
                for (const link of interviewers?.create ?? []) state.interviewers.push({ interviewId: row.id, ...link });
                return shape(hydrate[table] ? hydrate[table](row) : row, args);
            }),
        };
        return Object.fromEntries(Object.entries(ops).map(([op, impl]) => [op, jest.fn(impl)]));
    }

    const db = {
        candidateTestBlueprint: model("candidateTestBlueprint", "blueprints", {
            defaults: () => ({
                status: "DRAFT", version: 1, approvedByHiringManagerId: null, hiringManagerApprovedAt: null,
                approvedByHrId: null, hrApprovedAt: null, publishedAt: null, createdById: null,
            }),
        }),
        candidateTestBlueprintLink: model("candidateTestBlueprintLink", "links", { defaults: () => ({ isActive: true, scopeId: null, scopeKey: null, createdById: null }) }),
        candidateTestItem: model("candidateTestItem", "items"),
        candidateTestResult: model("candidateTestResult", "results"),
        jobRequisition: model("jobRequisition", "requisitions"),
        gradeLevel: model("gradeLevel", "gradeLevels"),
        application: model("application", "applications"),
        interview: model("interview", "interviews", {
            defaults: () => ({ status: "SCHEDULED", assessmentRequired: false, assessmentStatus: "NOT_REQUIRED", assessmentBlueprintId: null }),
        }),
        leaveRequest: model("leaveRequest", "leave"),
        testWorkstation: model("testWorkstation", "workstations", { defaults: () => ({ status: "ACTIVE", lastSeenAt: null, revokedAt: null, revokedById: null }) }),
        outboxEvent: { create: jest.fn(async () => ({})) },
        $executeRaw: jest.fn(async () => 1),
        contextLog,
    };
    db.$transaction = jest.fn(async (fn) => {
        const snapshot = structuredClone(state);
        try {
            return await fn(db);
        } catch (err) {
            for (const key of Object.keys(state)) state[key] = snapshot[key];
            throw err;
        }
    });

    const reset = () => {
        for (const key of Object.keys(state)) state[key] = [];
        contextLog.length = 0;
    };
    return { db, state, reset };
}

/** The outbox writer, mocked: records each event (tenant-less events dropped). */
export function createEventRecorder() {
    const events = [];
    const enqueueHrDomainEvent = jest.fn(async (_tx, args) => {
        if (!args?.tenantId) return null;
        events.push(structuredClone(args));
        return { id: events.length };
    });
    return { events, enqueueHrDomainEvent };
}
