// tests/unit/services/helpers/onboarding-self.fake.js
//
// An in-memory stand-in for the Prisma models the Phase 4 self portal touches
// (employees, onboarding checklists, tasks, documents, sessions, surveys,
// buddies, outbox events). It keeps the two behaviours the code depends on:
//   * queries are LAZY and read the request context when awaited, so a query
//     that escapes its mcpCtx.run / tenantTransaction fails (HR-4030) the way
//     FORCE RLS would, and every executed query records its tenant and tx;
//   * a tenant context sees only its own tenant's rows (Employee keys on
//     tenant_id, the onboarding tables on tenantId); SYSTEM sees all.
// A failed $transaction rolls the whole state back.
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const num = (v) => (isDate(v) ? v.getTime() : v);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function condMatches(value, cond) {
    const v = value === undefined ? null : value;
    if (cond === null) return v === null;
    if (isDate(cond)) return num(v) === cond.getTime();
    if (typeof cond !== "object" || Array.isArray(cond)) return v === cond;
    for (const [op, arg] of Object.entries(cond)) {
        if (op === "in" && !arg.map(num).includes(num(v))) return false;
        if (op === "notIn" && arg.map(num).includes(num(v))) return false;
        if (op === "not" && (arg === null ? v === null : num(v) === num(arg))) return false;
        if (op === "equals" && num(v) !== num(arg)) return false;
        if (op === "lt" && !(v != null && num(v) < num(arg))) return false;
        if (op === "gt" && !(v != null && num(v) > num(arg))) return false;
    }
    return true;
}

const matches = (row, where = {}) =>
    Object.entries(where).every(([key, cond]) => {
        if (cond === undefined) return true;
        if (key === "OR") return cond.some((w) => matches(row, w));
        return condMatches(row[key], cond);
    });

function sortRows(list, orderBy) {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o));
    return [...list].sort((a, b) => {
        for (const [key, dir] of keys) {
            const x = num(a[key]) ?? -Infinity;
            const y = num(b[key]) ?? -Infinity;
            if (x < y) return dir === "desc" ? 1 : -1;
            if (x > y) return dir === "desc" ? -1 : 1;
        }
        return 0;
    });
}

const project = (row, select) => {
    if (!row) return row ?? null;
    if (!select) return clone(row);
    const out = {};
    for (const [key, on] of Object.entries(select)) if (on) out[key] = clone(row[key]);
    return out;
};

const DEFAULTS = {
    onboardingChecklist: () => ({ status: "NOT_STARTED", currentStage: null, targetDate: null, title: "Employee Onboarding" }),
    onboardingTask: () => ({ completed: false, completedAt: null, sortOrder: 0, assigneeId: null, category: "OTHER", assigneeType: "HR" }),
    onboardingDocument: () => ({
        category: null, requiresSign: false, signedAt: null, signedByEmpId: null, source: "HR", reviewStatus: null,
        reviewedAt: null, reviewedById: null, reviewNote: null, created_at: new Date(),
    }),
    onboardingSurvey: () => ({ responses: null, submittedAt: null, issuedAt: null, dueAt: null, remindedAt: null }),
};

const MODELS = [
    "employee", "onboardingChecklist", "onboardingTask", "onboardingDocument", "onboardingSession",
    "onboardingSurvey", "onboardingBuddy", "outboxEvent",
];

export function makeSelfPortalDb() {
    const state = { tables: Object.fromEntries(MODELS.map((m) => [m, []])), ops: [], nextId: 9000 };
    let activeTx = null;

    const scope = (model, op) => {
        const store = mcpCtx.getStore();
        if (!store?.system && !store?.user?.tenantId) {
            throw Object.assign(new Error(`HR-4030: ${model}.${op} ran without a tenant context`), { code: "HR-4030", status: 403 });
        }
        const tenant = store.system ? null : store.user.tenantId;
        state.ops.push({ model, op, tenant: tenant ?? "SYSTEM", tx: activeTx });
        const col = model === "employee" ? "tenant_id" : "tenantId";
        return (row) => tenant == null || row[col] === tenant;
    };

    const lazy = (fn) => ({
        then(resolve, reject) {
            let p;
            try {
                p = Promise.resolve(fn());
            } catch (err) {
                p = Promise.reject(err);
            }
            return p.then(resolve, reject);
        },
    });

    const delegate = (model) => {
        const rows = () => state.tables[model];
        const visibleWhere = (vis, where) => rows().filter((r) => vis(r) && matches(r, where));
        return {
            findFirst: ({ where, select, orderBy } = {}) =>
                lazy(() => {
                    const vis = scope(model, "findFirst");
                    return project(sortRows(visibleWhere(vis, where), orderBy)[0] ?? null, select);
                }),
            findMany: ({ where, select, orderBy, skip = 0, take } = {}) =>
                lazy(() => {
                    const vis = scope(model, "findMany");
                    const list = sortRows(visibleWhere(vis, where), orderBy).slice(skip, take == null ? undefined : skip + take);
                    return list.map((r) => project(r, select));
                }),
            count: ({ where } = {}) =>
                lazy(() => {
                    const vis = scope(model, "count");
                    return visibleWhere(vis, where).length;
                }),
            create: ({ data, select }) =>
                lazy(() => {
                    scope(model, "create");
                    const row = { id: state.nextId++, ...(DEFAULTS[model]?.() ?? {}), ...clone(data) };
                    rows().push(row);
                    return project(row, select);
                }),
            updateMany: ({ where, data }) =>
                lazy(() => {
                    const vis = scope(model, "updateMany");
                    const hit = visibleWhere(vis, where);
                    for (const row of hit) Object.assign(row, clone(data));
                    return { count: hit.length };
                }),
        };
    };

    const db = Object.fromEntries(MODELS.map((m) => [m, delegate(m)]));
    db.$executeRaw = () => lazy(() => 1);
    db.$transaction = async (fn) => {
        const snapshot = structuredClone(state.tables);
        const prev = activeTx;
        activeTx = (prev ?? 0) + 1;
        try {
            return await fn(db);
        } catch (err) {
            state.tables = snapshot;
            throw err;
        } finally {
            activeTx = prev;
        }
    };

    const seed = (model, row) => {
        const full = { id: state.nextId++, ...(DEFAULTS[model]?.() ?? {}), ...row };
        state.tables[model].push(full);
        return full;
    };
    const all = (model) => state.tables[model];
    const events = () => state.tables.outboxEvent;
    return { db, state, seed, all, events };
}
