// tests/unit/services/helpers/recruitment-alerts.fake.js
//
// An in-memory stand-in for the Prisma models the Phase 5 analytics alerts
// touch. Like the other fakes here:
//   * queries are LAZY and read the request context when awaited, so a query
//     that escapes its mcpCtx.run / tenantTransaction fails (HR-4030) the way
//     FORCE RLS would, and every executed query records its tenant and tx;
//   * a tenant context sees only its own tenant's rows (Employee keys on
//     tenant_id, the rest on tenantId); SYSTEM sees all.
// A failed $transaction rolls the whole state back. Relation selects are not
// modelled: the metric reads are seeded as already-shaped rows.
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
        if (op === "not" && typeof arg === "object" && arg !== null && !isDate(arg)) {
            // Prisma.AnyNull / DbNull sentinels: "not null".
            if (v === null) return false;
            continue;
        }
        if (op === "not" && (arg === null ? v === null : num(v) === num(arg))) return false;
        if (op === "equals" && num(v) !== num(arg)) return false;
        if (op === "gte" && !(v != null && num(v) >= num(arg))) return false;
        if (op === "lte" && !(v != null && num(v) <= num(arg))) return false;
        if (op === "lt" && !(v != null && num(v) < num(arg))) return false;
        if (op === "gt" && !(v != null && num(v) > num(arg))) return false;
        if (op === "contains" && !(typeof v === "string" && v.toLowerCase().includes(String(arg).toLowerCase()))) return false;
    }
    return true;
}

const matches = (row, where = {}) =>
    Object.entries(where).every(([key, cond]) => {
        if (cond === undefined) return true;
        if (key === "OR") return cond.some((w) => matches(row, w));
        if (key === "mode") return true;
        if (cond && typeof cond === "object" && !isDate(cond) && !Array.isArray(cond) && "some" in cond) return true;
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
    recruitmentAlert: () => ({
        status: "OPEN", details: null, firstSeenAt: new Date(), lastSeenAt: new Date(),
        acknowledgedById: null, acknowledgedAt: null, resolvedAt: null,
    }),
};

const MODELS = [
    "tenantRecruitmentSettings", "recruitmentAlert", "employee", "jobRequisition", "application",
    "offer", "offerHandoff", "outboxEvent",
];

export function makeAlertsDb() {
    const state = { tables: Object.fromEntries(MODELS.map((m) => [m, []])), ops: [], nextId: 500 };
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
        const visible = (vis, where) => rows().filter((r) => vis(r) && matches(r, where));
        const pk = model === "tenantRecruitmentSettings" ? "tenantId" : "id";
        return {
            findFirst: ({ where, select, orderBy } = {}) =>
                lazy(() => project(sortRows(visible(scope(model, "findFirst"), where), orderBy)[0] ?? null, select)),
            findUnique: ({ where, select } = {}) =>
                lazy(() => project(visible(scope(model, "findUnique"), where)[0] ?? null, select)),
            findMany: ({ where, select, orderBy, take } = {}) =>
                lazy(() => {
                    const list = sortRows(visible(scope(model, "findMany"), where), orderBy).slice(0, take ?? undefined);
                    return list.map((r) => project(r, select));
                }),
            create: ({ data }) =>
                lazy(() => {
                    scope(model, "create");
                    const row = { id: state.nextId++, ...(DEFAULTS[model]?.() ?? {}), ...clone(data) };
                    rows().push(row);
                    return clone(row);
                }),
            update: ({ where, data }) =>
                lazy(() => {
                    const hit = visible(scope(model, "update"), where)[0];
                    if (!hit) throw Object.assign(new Error("Record not found"), { code: "P2025" });
                    Object.assign(hit, clone(data));
                    return clone(hit);
                }),
            updateMany: ({ where, data }) =>
                lazy(() => {
                    const hit = visible(scope(model, "updateMany"), where);
                    for (const row of hit) Object.assign(row, clone(data));
                    return { count: hit.length };
                }),
            upsert: ({ where, create, update }) =>
                lazy(() => {
                    const hit = visible(scope(model, "upsert"), where)[0];
                    if (!hit) {
                        const row = { ...clone(create) };
                        rows().push(row);
                        return clone(row);
                    }
                    for (const [k, v] of Object.entries(update)) {
                        hit[k] = v && typeof v === "object" && "increment" in v ? (hit[k] ?? 0) + v.increment : clone(v);
                    }
                    return clone(hit);
                }),
            _pk: pk,
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
    return { db, state, seed, all };
}
