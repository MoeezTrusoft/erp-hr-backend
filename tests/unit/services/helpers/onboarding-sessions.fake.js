// tests/unit/services/helpers/onboarding-sessions.fake.js
//
// An in-memory stand-in for the Prisma models the Phase 4 orientation code
// touches: onboarding sessions (with the unique checklist + templateKey),
// checklists (with their employee), templates, buddies, employees, offers
// (with their requisition). Where-clauses are evaluated by the scheduling
// fake's matcher.
//
// The Prisma behaviours the code depends on are kept: queries are LAZY and
// read the request context when awaited (a query outside mcpCtx.run fails
// HR-4030 like FORCE RLS), a tenant context sees only its own rows, SYSTEM
// sees all, createMany skipDuplicates honours the unique index, and a failed
// $transaction rolls back.
import { jest } from "@jest/globals";
import { mcpCtx } from "../../../../src/lib/requestContext.js";
import { matches } from "./interview-scheduling.fake.js";

const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const num = (v) => (isDate(v) ? v.getTime() : v);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

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

export const SESSION_DEFAULTS = Object.freeze({
    sessionDate: null,
    fromTime: null,
    toTime: null,
    sessionType: null,
    location: null,
    assigneeId: null,
    templateKey: null,
    required: false,
    calendarProvider: null,
    calendarEventId: null,
    calendarSyncedAt: null,
    calendarSyncStatus: null,
    calendarSyncAction: null,
    calendarSyncAttempts: 0,
    calendarNextAttemptAt: null,
    calendarLastError: null,
    calendarClaimedBy: null,
    calendarClaimExpiresAt: null,
});

export function createOnboardingDb() {
    const state = { sessions: [], checklists: [], templates: [], buddies: [], employees: [], offers: [], requisitions: [] };
    const contextLog = [];
    let nextId = 500;

    const hydrate = {
        sessions: (s) => {
            const checklist = state.checklists.find((c) => c.id === s.checklistId) ?? null;
            return { ...s, checklist: checklist && { ...checklist, employee: state.employees.find((e) => e.id === checklist.employeeId) ?? null } };
        },
        checklists: (c) => ({ ...c, employee: state.employees.find((e) => e.id === c.employeeId) ?? null }),
        offers: (o) => ({ ...o, jobRequisition: state.requisitions.find((r) => r.id === o.jobRequisitionId) ?? null }),
    };
    const RELATIONS = ["checklist", "employee", "jobRequisition"];
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
        const plain = { ...row };
        for (const r of RELATIONS) delete plain[r];
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

    const duplicate = (table, row) =>
        table === "sessions" && row.templateKey != null &&
        state.sessions.some((s) => s.checklistId === row.checklistId && s.templateKey === row.templateKey);

    function model(name, table, defaults = {}) {
        const insert = (ctx, data) => {
            assertWritable(table, ctx, data);
            const now = new Date();
            const row = { id: nextId++, ...clone(defaults), createdAt: now, updatedAt: now };
            applyData(row, data);
            return row;
        };
        const ops = {
            findFirst: (args = {}) => lazy(name, "findFirst", (ctx) =>
                shape(sortRows(visible(table, ctx), args.orderBy).find((r) => matches(r, args.where)), args)),
            findMany: (args = {}) => lazy(name, "findMany", (ctx) => {
                let rows = sortRows(visible(table, ctx).filter((r) => matches(r, args.where)), args.orderBy);
                if (args.take != null) rows = rows.slice(0, args.take);
                return rows.map((r) => shape(r, args));
            }),
            updateMany: (args = {}) => lazy(name, "updateMany", (ctx) => {
                const ids = new Set(visible(table, ctx).filter((r) => matches(r, args.where)).map((r) => r.id));
                const hit = state[table].filter((r) => ids.has(r.id));
                for (const row of hit) applyData(row, { ...args.data, updatedAt: new Date() });
                return { count: hit.length };
            }),
            deleteMany: (args = {}) => lazy(name, "deleteMany", (ctx) => {
                const ids = new Set(visible(table, ctx).filter((r) => matches(r, args.where)).map((r) => r.id));
                const before = state[table].length;
                state[table] = state[table].filter((r) => !ids.has(r.id));
                return { count: before - state[table].length };
            }),
            delete: (args = {}) => lazy(name, "delete", (ctx) => {
                const target = visible(table, ctx).find((r) => matches(r, args.where));
                if (!target) throw Object.assign(new Error("Record to delete does not exist."), { code: "P2025" });
                state[table] = state[table].filter((r) => r.id !== target.id);
                return shape(target, args);
            }),
            update: (args = {}) => lazy(name, "update", (ctx) => {
                const target = visible(table, ctx).find((r) => matches(r, args.where));
                if (!target) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
                const row = state[table].find((r) => r.id === target.id);
                applyData(row, { ...args.data, updatedAt: new Date() });
                return shape(hydrate[table] ? hydrate[table](row) : row, args);
            }),
            create: (args = {}) => lazy(name, "create", (ctx) => {
                const row = insert(ctx, args.data);
                if (duplicate(table, row)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                state[table].push(row);
                return shape(hydrate[table] ? hydrate[table](row) : row, args);
            }),
            createMany: (args = {}) => lazy(name, "createMany", (ctx) => {
                let count = 0;
                for (const data of args.data) {
                    const row = insert(ctx, data);
                    if (duplicate(table, row)) {
                        if (args.skipDuplicates) continue;
                        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                    }
                    state[table].push(row);
                    count += 1;
                }
                return { count };
            }),
        };
        return Object.fromEntries(Object.entries(ops).map(([op, impl]) => [op, jest.fn(impl)]));
    }

    const db = {
        onboardingSession: model("onboardingSession", "sessions", SESSION_DEFAULTS),
        onboardingChecklist: model("onboardingChecklist", "checklists"),
        onboardingChecklistTemplate: model("onboardingChecklistTemplate", "templates", { sessions: null, isActive: true, isDefault: false }),
        onboardingBuddy: model("onboardingBuddy", "buddies"),
        employee: model("employee", "employees"),
        offer: model("offer", "offers"),
        tenantRecruitmentSettings: { findUnique: jest.fn(() => lazy("tenantRecruitmentSettings", "findUnique", () => null)) },
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

    const addSession = (over = {}) => {
        const now = new Date();
        const row = { id: nextId++, ...clone(SESSION_DEFAULTS), createdAt: now, updatedAt: now, ...over };
        state.sessions.push(row);
        return row;
    };

    return { db, state, contextLog, addSession };
}
