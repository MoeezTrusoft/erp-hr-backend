// tests/unit/services/helpers/onboarding-provisioning.fake.js
//
// An in-memory stand-in for the Prisma client parts the Phase 4 provisioning
// service uses. What it keeps from the real client:
//   * LAZY queries: nothing runs until awaited, and the request context is read
//     at that moment (an unawaited query returned from mcpCtx.run fails HR-4030);
//   * a tenant context sees only its own tenant's rows (tenantId, or tenant_id
//     on Employee), the RLS policy and the tenant-scope extension together;
//   * the unique taskId on onboardingProvisioningRequest, with skipDuplicates;
//   * $transaction rolls the state back when its callback throws, and every
//     operation records the tenant and transaction it ran under.
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const time = (v) => (v instanceof Date ? v.getTime() : v == null ? null : new Date(v).getTime());
const isDate = (v) => v instanceof Date;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

const UNIQUES = { onboardingProvisioningRequest: [["taskId"]] };
const DEFAULTS = {
    onboardingProvisioningRequest: () => ({
        status: "REQUESTED", version: 0, acknowledgedAt: null, fulfilledAt: null, fulfilledById: null,
        externalRef: null, notes: null, dueDate: null, requestedAt: new Date(),
    }),
    onboardingTask: () => ({ completed: false, completedAt: null, assigneeId: null, dueDate: null, sortOrder: 0 }),
};

function condMatches(value, cond) {
    if (cond === null) return value === null || value === undefined;
    if (isDate(cond)) return time(value) === cond.getTime();
    if (typeof cond !== "object" || Array.isArray(cond)) return (value ?? null) === cond;
    for (const [op, arg] of Object.entries(cond)) {
        if (op === "in" && !arg.includes(value)) return false;
        if (op === "notIn" && arg.includes(value)) return false;
        if (op === "not" && condMatches(value, arg)) return false;
        if (op === "lt" && !(value != null && time(value) < time(arg))) return false;
        if (op === "lte" && !(value != null && time(value) <= time(arg))) return false;
        if (op === "gt" && !(value != null && time(value) > time(arg))) return false;
        if (op === "gte" && !(value != null && time(value) >= time(arg))) return false;
    }
    return true;
}

function matches(row, where) {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
        if (cond === undefined) continue;
        if (key === "AND") {
            if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w))) return false;
        } else if (key === "OR") {
            if (!cond.some((w) => matches(row, w))) return false;
        } else if (!condMatches(row[key], cond)) {
            return false;
        }
    }
    return true;
}

const project = (row, select) => {
    if (!row) return row;
    if (!select) return clone(row);
    return Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, clone(row[k])]));
};

const sortRows = (list, orderBy) => {
    const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o));
    return [...list].sort((a, b) => {
        for (const [field, spec] of specs) {
            const dir = typeof spec === "string" ? spec : spec.sort;
            const nullsLast = typeof spec === "object" && spec.nulls === "last";
            const av = time(a[field]) ?? a[field];
            const bv = time(b[field]) ?? b[field];
            if (av === bv) continue;
            if (av == null) return nullsLast ? 1 : -1;
            if (bv == null) return nullsLast ? -1 : 1;
            const cmp = av < bv ? -1 : 1;
            return dir === "desc" ? -cmp : cmp;
        }
        return 0;
    });
};

export function makeProvisioningDb() {
    const state = { tables: {}, ops: [], nextId: 1000, txSeq: 0 };
    const rows = (model) => (state.tables[model] ??= []);
    let activeTx = null;

    const scope = (model, op) => {
        const store = mcpCtx.getStore();
        if (!store?.system && !store?.user?.tenantId) {
            throw Object.assign(new Error(`HR-4030: ${model}.${op} ran without a tenant context`), { code: "HR-4030", status: 403 });
        }
        const tenant = store.system ? null : store.user.tenantId;
        state.ops.push({ model, op, tenant: tenant ?? "SYSTEM", tx: activeTx });
        return (row) => {
            if (tenant == null) return true;
            const owner = "tenantId" in row ? row.tenantId : row.tenant_id;
            return owner === tenant;
        };
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

    const violates = (model, row) =>
        (UNIQUES[model] ?? []).some((fields) =>
            fields.every((f) => row[f] != null) && rows(model).some((r) => r !== row && fields.every((f) => r[f] === row[f])));

    function applyData(row, data) {
        for (const [key, value] of Object.entries(data ?? {})) {
            if (value === undefined) continue;
            if (value && typeof value === "object" && !isDate(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
            else row[key] = isDate(value) ? new Date(value) : clone(value);
        }
        row.updatedAt = new Date();
    }

    const newRow = (model, data) => {
        const row = { id: state.nextId++, createdAt: new Date(), ...(DEFAULTS[model]?.() ?? {}) };
        applyData(row, data);
        return row;
    };

    const table = (model) => ({
        findMany: ({ where, select, orderBy, take, skip } = {}) =>
            lazy(() => {
                const visible = scope(model, "findMany");
                const list = sortRows(rows(model).filter(visible).filter((r) => matches(r, where)), orderBy);
                return list.slice(skip ?? 0, (skip ?? 0) + (take ?? list.length)).map((r) => project(r, select));
            }),
        findFirst: ({ where, select, orderBy } = {}) =>
            lazy(() => {
                const visible = scope(model, "findFirst");
                return project(sortRows(rows(model).filter(visible).filter((r) => matches(r, where)), orderBy)[0] ?? null, select);
            }),
        count: ({ where } = {}) =>
            lazy(() => {
                const visible = scope(model, "count");
                return rows(model).filter(visible).filter((r) => matches(r, where)).length;
            }),
        create: ({ data, select }) =>
            lazy(() => {
                scope(model, "create");
                const row = newRow(model, data);
                if (violates(model, row)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                rows(model).push(row);
                return project(row, select);
            }),
        createManyAndReturn: ({ data, skipDuplicates }) =>
            lazy(() => {
                scope(model, "createManyAndReturn");
                const out = [];
                for (const item of Array.isArray(data) ? data : [data]) {
                    const row = newRow(model, item);
                    if (violates(model, row)) {
                        if (!skipDuplicates) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                        continue;
                    }
                    rows(model).push(row);
                    out.push(clone(row));
                }
                return out;
            }),
        update: ({ where, data, select }) =>
            lazy(() => {
                const visible = scope(model, "update");
                const row = rows(model).filter(visible).find((r) => matches(r, where));
                if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
                applyData(row, data);
                return project(row, select);
            }),
        updateMany: ({ where, data }) =>
            lazy(() => {
                const visible = scope(model, "updateMany");
                const hit = rows(model).filter(visible).filter((r) => matches(r, where));
                for (const row of hit) applyData(row, data);
                return { count: hit.length };
            }),
    });

    const db = new Proxy(
        {
            state,
            rows,
            $executeRaw: () => lazy(() => 1),
            async $transaction(fn) {
                const outer = activeTx;
                const snapshot = outer ? null : clone(state.tables);
                activeTx = ++state.txSeq;
                const tx = new Proxy({ txId: activeTx }, { get: (target, prop) => (prop in target ? target[prop] : db[prop]) });
                try {
                    return await fn(tx);
                } catch (err) {
                    if (snapshot) state.tables = snapshot;
                    throw err;
                } finally {
                    activeTx = outer;
                }
            },
        },
        {
            get(target, prop) {
                if (prop in target) return target[prop];
                if (typeof prop !== "string" || prop.startsWith("$") || prop === "then") return undefined;
                target[prop] = table(prop);
                return target[prop];
            },
        },
    );
    return db;
}

/** Records hr domain events the way the outbox writer would receive them. */
export function eventRecorder() {
    const events = [];
    const enqueueHrDomainEvent = async (tx, event) => {
        if (event) events.push({ ...event, txId: tx?.txId ?? null });
        return event;
    };
    return { events, enqueueHrDomainEvent, named: (name) => events.filter((e) => e.eventName === `hr.onboarding.${name}.v1`) };
}
