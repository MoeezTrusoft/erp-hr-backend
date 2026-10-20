// tests/unit/services/helpers/internal-mobility.fake.js
//
// An in-memory stand-in for the Prisma models the Phase 5 internal board and
// referrals touch. It keeps the behaviours the code depends on:
//   * queries are LAZY and read the request context when awaited, so a query
//     that escapes its mcpCtx.run / tenantTransaction fails (HR-4030) the way
//     FORCE RLS would, and every executed query records its tenant and tx;
//   * a tenant context sees only its own tenant's rows (Employee keys on
//     tenant_id, the rest on tenantId); SYSTEM sees all;
//   * the where-clause operators the services use (in, not, equals with
//     mode insensitive, contains, lt/lte/gt/gte, AND/OR, postings.some) and a
//     nested postings select on jobRequisition;
//   * { increment } in update data; a failed $transaction rolls back.
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const num = (v) => (isDate(v) ? v.getTime() : v);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const fold = (v, mode) => (mode === "insensitive" && typeof v === "string" ? v.toLowerCase() : v);

function condMatches(value, cond) {
    const v = value === undefined ? null : value;
    if (cond === null) return v === null;
    if (isDate(cond)) return num(v) === cond.getTime();
    if (typeof cond !== "object" || Array.isArray(cond)) return v === cond;
    const mode = cond.mode;
    for (const [op, arg] of Object.entries(cond)) {
        if (op === "mode") continue;
        if (op === "in" && !arg.map(num).includes(num(v))) return false;
        if (op === "notIn" && arg.map(num).includes(num(v))) return false;
        // SQL semantics: `<> x` never matches NULL.
        if (op === "not" && (arg === null ? v === null : v === null || num(v) === num(arg))) return false;
        if (op === "equals" && fold(num(v), mode) !== fold(num(arg), mode)) return false;
        if (op === "contains" && !(typeof v === "string" && fold(v, mode).includes(fold(arg, mode)))) return false;
        if (op === "lt" && !(v != null && num(v) < num(arg))) return false;
        if (op === "lte" && !(v != null && num(v) <= num(arg))) return false;
        if (op === "gt" && !(v != null && num(v) > num(arg))) return false;
        if (op === "gte" && !(v != null && num(v) >= num(arg))) return false;
    }
    return true;
}

export function makeInternalMobilityDb() {
    const MODELS = [
        "employee", "jobRequisition", "jobPosting", "candidate", "candidateConsent", "application",
        "applicationStageHistory", "internalReferral", "offer", "offerHandoff", "tenantRecruitmentSettings", "outboxEvent",
    ];
    const state = { tables: Object.fromEntries(MODELS.map((m) => [m, []])), ops: [], nextId: 5000 };
    let activeTx = null;

    const RELATIONS = {
        jobRequisition: { postings: (row) => state.tables.jobPosting.filter((p) => p.requisitionId === row.id) },
    };

    const matches = (model, row, where = {}) =>
        Object.entries(where).every(([key, cond]) => {
            if (cond === undefined) return true;
            if (key === "OR") return cond.some((w) => matches(model, row, w));
            if (key === "AND") return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(model, row, w));
            if (key === "NOT") return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(model, row, w));
            const relation = RELATIONS[model]?.[key];
            if (relation) {
                const target = key === "postings" ? "jobPosting" : key;
                if (cond.some) return relation(row).some((r) => matches(target, r, cond.some));
                if (cond.none) return !relation(row).some((r) => matches(target, r, cond.none));
                throw new Error(`fake: unsupported relation filter on ${model}.${key}`);
            }
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

    const project = (model, row, select) => {
        if (!row) return row ?? null;
        if (!select) return clone(row);
        const out = {};
        for (const [key, on] of Object.entries(select)) {
            if (!on) continue;
            const relation = RELATIONS[model]?.[key];
            if (relation) {
                const spec = on === true ? {} : on;
                const target = key === "postings" ? "jobPosting" : key;
                const rows = sortRows(relation(row).filter((r) => matches(target, r, spec.where ?? {})), spec.orderBy);
                out[key] = rows.map((r) => project(target, r, spec.select));
            } else out[key] = clone(row[key]);
        }
        return out;
    };

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

    const applyData = (row, data) => {
        for (const [key, value] of Object.entries(clone(data))) {
            if (value && typeof value === "object" && !isDate(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
            else row[key] = value;
        }
        row.updatedAt = new Date();
    };

    const DEFAULTS = {
        internalReferral: () => ({
            candidateId: null, applicationId: null, relationship: null, note: null, status: "SUBMITTED", hiredAt: null,
            bonusStatus: "NOT_ELIGIBLE", bonusEligibleAt: null, bonusAmount: null, bonusCurrency: null,
            bonusDecidedById: null, bonusDecidedAt: null, version: 0, createdAt: new Date(), updatedAt: new Date(),
        }),
        candidate: () => ({ status: "active", archivedAt: null, anonymizedAt: null, consentStatus: "UNKNOWN", version: 0 }),
        application: () => ({ stage: "applied", status: "open", applicantEmployeeId: null, sourceDetail: null }),
        jobPosting: () => ({ isActive: true, closedAt: null, postedAt: new Date("2026-10-01T00:00:00Z"), channel: "CAREER_SITE" }),
        jobRequisition: () => ({ status: "POSTED", closesAt: null, recruiterId: null, replacementEmployeeId: null, publishedAt: new Date("2026-10-01T00:00:00Z") }),
    };

    const delegate = (model) => {
        const rows = () => state.tables[model];
        const visible = (vis, where) => rows().filter((r) => vis(r) && matches(model, r, where));
        return {
            findFirst: ({ where, select, orderBy } = {}) =>
                lazy(() => project(model, sortRows(visible(scope(model, "findFirst"), where), orderBy)[0] ?? null, select)),
            findUnique: ({ where, select } = {}) =>
                lazy(() => project(model, visible(scope(model, "findUnique"), where)[0] ?? null, select)),
            findMany: ({ where, select, orderBy, skip = 0, take } = {}) =>
                lazy(() => {
                    const list = sortRows(visible(scope(model, "findMany"), where), orderBy).slice(skip, take == null ? undefined : skip + take);
                    return list.map((r) => project(model, r, select));
                }),
            count: ({ where } = {}) => lazy(() => visible(scope(model, "count"), where).length),
            create: ({ data, select }) =>
                lazy(() => {
                    scope(model, "create");
                    const row = { id: state.nextId++, ...(DEFAULTS[model]?.() ?? {}), ...clone(data) };
                    rows().push(row);
                    return project(model, row, select);
                }),
            updateMany: ({ where, data }) =>
                lazy(() => {
                    const hit = visible(scope(model, "updateMany"), where);
                    for (const row of hit) applyData(row, data);
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
    const events = () => state.tables.outboxEvent.map((row) => row.payload ?? row);
    return { db, state, seed, all, events };
}
