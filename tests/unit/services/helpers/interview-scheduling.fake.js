// tests/unit/services/helpers/interview-scheduling.fake.js
//
// An in-memory stand-in for the Prisma models the Phase 3a scheduling code
// touches: interviews (with their panel), employees, applications,
// candidates, requisitions, leave, work schedules, slot offers and lifecycle
// events, reminders. It evaluates the where-clauses the code builds (equality, in /
// notIn / lt / lte / gt / gte / not, OR / AND, `some` / `none`, `is` and
// nested to-one relation filters), projects `select` / `include`, applies
// `{ increment }`, and rolls a failed $transaction back.
//
// The two Prisma behaviours the code depends on are kept:
//   * queries are LAZY and read the request context when awaited, so a query
//     that escapes its mcpCtx.run / tenantTransaction fails (HR-4030) the way
//     FORCE RLS would, and every executed query is logged with its context;
//   * a tenant context sees only its own tenant's rows (RLS); SYSTEM sees all.
import { jest } from "@jest/globals";
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const OPS = new Set(["in", "notIn", "lt", "lte", "gt", "gte", "not", "equals", "some", "none", "is", "has"]);
// structuredClone (a Node global) makes Dates of the outer realm, so
// `instanceof Date` is not reliable inside jest's vm context.
const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const num = (v) => (isDate(v) ? v.getTime() : v);

function compare(value, op, arg) {
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
        case "some": return Array.isArray(v) && v.some((item) => matches(item, arg));
        case "none": return !Array.isArray(v) || !v.some((item) => matches(item, arg));
        case "is": return arg === null ? v == null : v != null && matches(v, arg);
        case "has": return Array.isArray(v) && v.includes(arg);
        default: throw new Error(`fake prisma: unsupported operator ${op}`);
    }
}

export function matches(row, where = {}) {
    return Object.entries(where ?? {}).every(([key, cond]) => {
        if (cond === undefined) return true;
        if (key === "OR") return cond.some((w) => matches(row, w));
        if (key === "AND") return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w));
        if (key === "NOT") return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w));
        const value = row?.[key];
        if (cond === null) return value == null;
        if (isDate(cond)) return num(value) === cond.getTime();
        if (typeof cond === "object" && !Array.isArray(cond)) {
            if (Object.keys(cond).some((k) => OPS.has(k))) {
                return Object.entries(cond).every(([op, arg]) => compare(value, op, arg));
            }
            return value != null && matches(value, cond);
        }
        return num(value) === num(cond);
    });
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function project(row, shape) {
    if (row == null) return row;
    if (Array.isArray(row)) return row.map((r) => project(r, shape));
    const out = {};
    for (const [key, sel] of Object.entries(shape)) {
        if (!sel) continue;
        if (sel === true) out[key] = clone(row[key]);
        else if (sel.select) out[key] = project(row[key], sel.select);
        else if (sel.include) out[key] = clone(row[key]);
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

export function createSchedulingDb() {
    const state = {
        interviews: [],
        interviewers: [],
        employees: [],
        applications: [],
        candidates: [],
        requisitions: [],
        leave: [],
        schedules: [],
        offers: [],
        lifecycle: [],
        reminders: [],
        scorecards: [],
    };
    const contextLog = [];
    let nextId = 1000;

    // Relations, resolved at read time so a filter or a select can follow them.
    const hydrateApplication = (a) => a && {
        ...a,
        candidate: state.candidates.find((c) => c.id === a.candidateId) ?? null,
        jobRequisition: state.requisitions.find((r) => r.id === a.jobRequisitionId) ?? null,
    };
    const hydrate = {
        interviews: (i) => ({
            ...i,
            application: hydrateApplication(state.applications.find((a) => a.id === i.applicationId)),
            interviewers: state.interviewers
                .filter((x) => x.interviewId === i.id)
                .map((x) => ({ ...x, employee: state.employees.find((e) => e.id === x.employeeId) ?? null })),
        }),
        applications: hydrateApplication,
        offers: (o) => ({ ...o, application: hydrateApplication(state.applications.find((a) => a.id === o.applicationId)) }),
    };
    const tenantKey = { employees: "tenant_id" };

    function visible(table, ctx) {
        const key = tenantKey[table] ?? "tenantId";
        const rows = state[table].map((r) => (hydrate[table] ? hydrate[table](r) : r));
        if (ctx?.system) return rows;
        return rows.filter((r) => r[key] === ctx.user.tenantId);
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

    const shape = (row, args) => {
        if (!row) return null;
        if (args?.select) return project(row, args.select);
        if (args?.include) return clone(row);
        const plain = { ...row };
        delete plain.application;
        delete plain.interviewers;
        delete plain.candidate;
        delete plain.jobRequisition;
        return clone(plain);
    };

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

    const assertWritable = (table, ctx, data) => {
        const key = tenantKey[table] ?? "tenantId";
        if (!ctx.system && data[key] !== ctx.user.tenantId) {
            throw Object.assign(new Error(`RLS: ${table} write for another tenant`), { code: "42501" });
        }
    };

    function model(name, table, extra = {}) {
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
                const hit = state[table].filter((r) => ids.has(r.id));
                for (const row of hit) applyData(row, { ...args.data, ...(table === "interviews" ? { updated_at: new Date() } : { updatedAt: new Date() }) });
                return { count: hit.length };
            }),
            deleteMany: (args = {}) => lazy(name, "deleteMany", (ctx) => {
                const ids = new Set(visible(table, ctx).filter((r) => matches(r, args.where)).map((r) => r.id));
                const before = state[table].length;
                state[table] = state[table].filter((r) => !ids.has(r.id));
                return { count: before - state[table].length };
            }),
            update: (args = {}) => lazy(name, "update", (ctx) => {
                const target = visible(table, ctx).find((r) => matches(r, args.where));
                if (!target) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
                const row = state[table].find((r) => r.id === target.id);
                applyData(row, args.data);
                return shape(hydrate[table] ? hydrate[table](row) : row, args);
            }),
            create: (args = {}) => lazy(name, "create", (ctx) => {
                const { interviewers, ...data } = args.data;
                assertWritable(table, ctx, data);
                const now = new Date();
                const row = { id: nextId++, ...(extra.defaults?.() ?? {}), created_at: now, createdAt: now, updatedAt: now, updated_at: now };
                applyData(row, data);
                if (table === "offers" && row.tokenHash && state.offers.some((o) => o.tokenHash === row.tokenHash)) {
                    throw Object.assign(new Error("Unique constraint failed on tokenHash"), { code: "P2002" });
                }
                state[table].push(row);
                for (const link of interviewers?.create ?? []) state.interviewers.push({ interviewId: row.id, ...link });
                return shape(hydrate[table] ? hydrate[table](row) : row, args);
            }),
        };
        return Object.fromEntries(Object.entries(ops).map(([op, impl]) => [op, jest.fn(impl)]));
    }

    const db = {
        interview: model("interview", "interviews", {
            defaults: () => ({ status: "SCHEDULED", calendarSyncAttempts: 0, calendarEventId: null, calendarProvider: null, calendarClaimedBy: null, calendarClaimExpiresAt: null, remindersPausedAt: null, noShowAt: null, slotOfferId: null }),
        }),
        employee: model("employee", "employees"),
        application: model("application", "applications"),
        candidate: model("candidate", "candidates"),
        jobRequisition: model("jobRequisition", "requisitions"),
        leaveRequest: model("leaveRequest", "leave"),
        workSchedule: model("workSchedule", "schedules"),
        interviewSlotOffer: model("interviewSlotOffer", "offers", {
            defaults: () => ({ status: "PROPOSED", version: 1, tokenHash: null, interviewId: null, cancelReason: null, cancelledAt: null, confirmedAt: null, chosenSlotStart: null, sentAt: null, expiresAt: null, location: null }),
        }),
        interviewLifecycleEvent: model("interviewLifecycleEvent", "lifecycle"),
        interviewReminder: model("interviewReminder", "reminders"),
        interviewScorecard: model("interviewScorecard", "scorecards"),
        $executeRaw: jest.fn(async () => 1),
        $queryRaw: jest.fn(async () => []),
        contextLog,
    };
    // A failed transaction leaves nothing behind. The rollback restores a
    // snapshot, so it is applied only when no other transaction overlapped
    // the failed one (restoring would also erase the other's writes); tests
    // of concurrent transactions assert on the guarded writes instead.
    let started = 0;
    let active = 0;
    db.$transaction = jest.fn(async (fn) => {
        const snapshot = structuredClone(state);
        const mySeq = ++started;
        active += 1;
        try {
            return await fn(db);
        } catch (err) {
            if (active === 1 && started === mySeq) {
                for (const key of Object.keys(state)) state[key] = snapshot[key];
            }
            throw err;
        } finally {
            active -= 1;
        }
    });

    return { db, state };
}

/** The outbox writer, mocked: records each event with the context it ran in. */
export function createEventRecorder() {
    const events = [];
    const enqueueHrDomainEvent = jest.fn(async (_tx, args) => {
        if (!args?.tenantId) return null;
        events.push(structuredClone(args));
        return { id: events.length };
    });
    return { events, enqueueHrDomainEvent };
}
