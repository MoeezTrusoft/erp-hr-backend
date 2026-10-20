// tests/unit/services/helpers/privacy-operations.fake.js
//
// An in-memory stand-in for the prisma models the Phase 5 privacy operations
// touch (retention runs, settings, data-subject requests and every
// candidate-linked table the access export reads). Any model name works: a
// table is created on first use.
//
// It evaluates the where-clauses the services build (equality, null,
// in/notIn/not/lt/lte/gt/gte, equals with mode insensitive, OR/AND), projects
// select with the few nested relations the services read, and — like Prisma —
// every query is LAZY: it runs when awaited and reads the request context
// then. A query awaited outside a tenant or SYSTEM context fails the way the
// deny-by-default scope would (HR-4030); a tenant-context query reading or
// writing another tenant's rows throws, so a cross-tenant leak fails a test.
// Every query is recorded with its context (contextLog).
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const RELATIONS = {
    application: {
        jobRequisition: (r, s) => s.table("jobRequisition").find((x) => x.id === r.jobRequisitionId) ?? null,
    },
    applicationAnswer: {
        question: (r, s) => s.table("applicationQuestion").find((x) => x.id === r.questionId) ?? null,
    },
    interview: {
        interviewers: (r, s) => s.table("interviewInterviewer").filter((x) => x.interviewId === r.id),
    },
    offer: {
        letterVersions: (r, s) => s.table("offerLetterVersion").filter((x) => x.offerId === r.id),
    },
    talentPoolInvitation: {
        jobRequisition: (r, s) => s.table("jobRequisition").find((x) => x.id === r.jobRequisitionId) ?? null,
    },
    candidateTag: {
        tag: (r, s) => s.table("tag").find((x) => x.id === r.tagId) ?? null,
    },
};

const TENANT_COLUMN = { employee: "tenant_id" };
const KEY = { tenantRecruitmentSettings: "tenantId" };

const num = (v) => (v instanceof Date ? v.getTime() : v);
const OPS = new Set(["in", "notIn", "lt", "lte", "gt", "gte", "not", "equals", "mode"]);

function matchValue(value, cond) {
    const v = value === undefined ? null : value;
    if (cond === null) return v === null;
    if (cond instanceof Date || typeof cond !== "object" || Array.isArray(cond)) return num(v) === num(cond);
    const keys = Object.keys(cond);
    if (!keys.every((k) => OPS.has(k))) return JSON.stringify(v) === JSON.stringify(cond);
    const insensitive = cond.mode === "insensitive";
    const norm = (x) => (insensitive && typeof x === "string" ? x.toLowerCase() : num(x));
    return keys.every((op) => {
        const arg = cond[op];
        switch (op) {
            case "mode": return true;
            case "equals": return norm(v) === norm(arg);
            case "in": return arg.map(norm).includes(norm(v));
            case "notIn": return !arg.map(norm).includes(norm(v));
            case "lt": return v != null && num(v) < num(arg);
            case "lte": return v != null && num(v) <= num(arg);
            case "gt": return v != null && num(v) > num(arg);
            case "gte": return v != null && num(v) >= num(arg);
            case "not":
                if (arg === null) return v !== null;
                if (typeof arg === "object" && !(arg instanceof Date)) return !matchValue(v, arg);
                // SQL semantics: NULL <> x is not true.
                return v !== null && num(v) !== num(arg);
            default: return false;
        }
    });
}

function matches(row, where = {}) {
    return Object.entries(where ?? {}).every(([key, cond]) => {
        if (key === "OR") return cond.some((w) => matches(row, w));
        if (key === "AND") return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w));
        if (key === "NOT") return !matches(row, cond);
        return matchValue(row[key], cond);
    });
}

const clone = (v) => (v instanceof Date ? new Date(v) : v && typeof v === "object" ? JSON.parse(JSON.stringify(v), revive) : v);
function revive(_k, v) {
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ? new Date(v) : v;
}

export function createPrivacyFake(seed = {}) {
    const tables = new Map();
    const contextLog = [];
    const ids = new Map();
    const store = {
        table(model) {
            if (!tables.has(model)) tables.set(model, []);
            return tables.get(model);
        },
    };
    for (const [model, rows] of Object.entries(seed)) store.table(model).push(...rows.map((r) => ({ ...r })));

    const nextId = (model) => {
        const rows = store.table(model);
        const current = ids.get(model) ?? rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
        ids.set(model, current + 1);
        return current + 1;
    };

    function project(model, row, select) {
        if (!select) return clone(row);
        const out = {};
        for (const [field, spec] of Object.entries(select)) {
            if (!spec) continue;
            const rel = RELATIONS[model]?.[field];
            if (rel) {
                const value = rel(row, store);
                const nested = spec === true ? null : spec.select ?? null;
                out[field] = Array.isArray(value) ? value.map((v) => project(field, v, nested)) : value ? project(field, value, nested) : null;
            } else {
                out[field] = clone(row[field] ?? null);
            }
        }
        return out;
    }

    function tenantGuard(model, rows, op) {
        const ctx = mcpCtx.getStore();
        contextLog.push({ model, op, system: ctx?.system === true, tenantId: ctx?.user?.tenantId ?? null });
        if (!ctx) throw Object.assign(new Error(`HR-4030: ${model}.${op} without a context`), { status: 403, code: "HR-4030" });
        if (ctx.system) return;
        const tenant = ctx.user?.tenantId;
        const col = TENANT_COLUMN[model] ?? "tenantId";
        for (const row of rows) {
            if (row && row[col] !== undefined && row[col] !== null && row[col] !== tenant) {
                throw new Error(`cross-tenant ${model}.${op}: row of ${row[col]} under ${tenant}`);
            }
        }
    }

    const lazy = (fn) => {
        let p = null;
        const run = () => (p ??= Promise.resolve().then(fn));
        return { then: (a, b) => run().then(a, b), catch: (b) => run().catch(b), finally: (f) => run().finally(f) };
    };

    const sortRows = (rows, orderBy) => {
        const list = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [{ id: "asc" }]).flatMap((o) => Object.entries(o));
        return [...rows].sort((a, b) => {
            for (const [k, dir] of list) {
                const av = num(a[k] ?? null);
                const bv = num(b[k] ?? null);
                if (av === bv) continue;
                const cmp = av == null ? -1 : bv == null ? 1 : av < bv ? -1 : 1;
                return dir === "desc" ? -cmp : cmp;
            }
            return 0;
        });
    };

    const modelApi = (model) => ({
        findMany: (args = {}) => lazy(() => {
            let rows = sortRows(store.table(model).filter((r) => matches(r, args.where)), args.orderBy);
            if (args.skip) rows = rows.slice(args.skip);
            if (args.take) rows = rows.slice(0, args.take);
            tenantGuard(model, rows, "findMany");
            return rows.map((r) => project(model, r, args.select));
        }),
        findFirst: (args = {}) => lazy(() => {
            const row = sortRows(store.table(model).filter((r) => matches(r, args.where)), args.orderBy)[0] ?? null;
            tenantGuard(model, [row], "findFirst");
            return row ? project(model, row, args.select) : null;
        }),
        findUnique: (args = {}) => lazy(() => {
            const row = store.table(model).find((r) => matches(r, args.where)) ?? null;
            tenantGuard(model, [row], "findUnique");
            return row ? project(model, row, args.select) : null;
        }),
        count: (args = {}) => lazy(() => {
            const rows = store.table(model).filter((r) => matches(r, args.where));
            tenantGuard(model, rows, "count");
            return rows.length;
        }),
        create: (args = {}) => lazy(() => {
            const row = { id: nextId(model), createdAt: new Date(), created_at: new Date(), ...args.data };
            tenantGuard(model, [row], "create");
            store.table(model).push(row);
            return project(model, row, args.select);
        }),
        updateMany: (args = {}) => lazy(() => {
            const rows = store.table(model).filter((r) => matches(r, args.where));
            tenantGuard(model, rows, "updateMany");
            for (const r of rows) applyData(r, args.data);
            return { count: rows.length };
        }),
        update: (args = {}) => lazy(() => {
            const row = store.table(model).find((r) => matches(r, args.where));
            if (!row) throw Object.assign(new Error(`${model}.update: record not found`), { code: "P2025" });
            tenantGuard(model, [row], "update");
            applyData(row, args.data);
            return project(model, row, args.select);
        }),
        deleteMany: (args = {}) => lazy(() => {
            const table = store.table(model);
            const rows = table.filter((r) => matches(r, args.where));
            tenantGuard(model, rows, "deleteMany");
            for (const r of rows) table.splice(table.indexOf(r), 1);
            return { count: rows.length };
        }),
        upsert: (args = {}) => lazy(() => {
            const table = store.table(model);
            const existing = table.find((r) => matches(r, args.where));
            tenantGuard(model, [existing ?? args.create], "upsert");
            if (existing) {
                applyData(existing, args.update);
                return project(model, existing, args.select);
            }
            const row = { ...(KEY[model] ? {} : { id: nextId(model) }), ...args.create };
            table.push(row);
            return project(model, row, args.select);
        }),
    });

    function applyData(row, data = {}) {
        for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === "object" && "increment" in v) row[k] = (Number(row[k]) || 0) + v.increment;
            else row[k] = v;
        }
    }

    const apis = new Map();
    const client = new Proxy(
        {
            contextLog,
            store,
            rows: (model) => store.table(model),
            $executeRaw: () => lazy(() => 1),
            $transaction: async (fn) => await fn(client),
        },
        {
            get(target, prop) {
                if (prop in target) return target[prop];
                if (typeof prop !== "string" || prop === "then") return undefined;
                if (!apis.has(prop)) apis.set(prop, modelApi(prop));
                return apis.get(prop);
            },
        },
    );
    return client;
}
