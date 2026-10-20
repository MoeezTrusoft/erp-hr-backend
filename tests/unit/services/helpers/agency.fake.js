// tests/unit/services/helpers/agency.fake.js
//
// An in-memory stand-in for the Prisma models the Phase 5 agency portal and
// the existing candidate / application reads touch. It keeps the behaviours
// the code depends on:
//   * queries are LAZY and read the request context when awaited, so a query
//     that escapes its mcpCtx.run / tenantTransaction fails (HR-4030) the way
//     FORCE RLS would, and every executed query records its tenant;
//   * a tenant context sees only its own tenant's rows; SYSTEM sees all;
//   * where-clauses support equality, in / notIn / not / equals / contains
//     (mode insensitive) / gt / gte / lt / lte, AND / OR / NOT, and relation
//     filters (some / is); include, select and omit resolve the relations
//     below. A failed $transaction rolls the whole state back.
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const num = (v) => (isDate(v) ? v.getTime() : v);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);

// model -> relation -> [kind, target model, foreign key]
//   one:    this[fk] = target.id         many / oneRev: target[fk] = this.id
const RELATIONS = {
    application: {
        candidate: ["one", "candidate", "candidateId"],
        jobRequisition: ["one", "jobRequisition", "jobRequisitionId"],
        interviews: ["many", "interview", "applicationId"],
        offer: ["oneRev", "offer", "applicationId"],
    },
    candidate: {
        tags: ["many", "candidateTag", "candidateId"],
        applications: ["many", "application", "candidateId"],
    },
    candidateTag: { tag: ["one", "tag", "tagId"] },
    agencySubmission: { agency: ["one", "recruitmentAgency", "agencyId"] },
    recruitmentAgencyUser: { agency: ["one", "recruitmentAgency", "agencyId"] },
    requisitionAgencyAssignment: { agency: ["one", "recruitmentAgency", "agencyId"] },
    jobRequisition: { postings: ["many", "jobPosting", "requisitionId"] },
};

const MODELS = [
    "jobRequisition", "jobPosting", "recruitmentAgency", "recruitmentAgencyUser", "requisitionAgencyAssignment",
    "agencySubmission", "candidate", "candidateTag", "tag", "application", "applicationStageHistory", "interview",
    "offer", "businessUnit", "outboxEvent",
];

const DEFAULTS = {
    recruitmentAgency: () => ({ status: "ACTIVE", ownershipDays: 180, feePercent: null, notes: null, contactEmail: null, version: 0, createdAt: new Date() }),
    recruitmentAgencyUser: () => ({ status: "ACTIVE", email: null, createdAt: new Date(), updatedAt: new Date() }),
    requisitionAgencyAssignment: () => ({ status: "ACTIVE", maxSubmissions: null, notes: null, assignedAt: new Date(), endedAt: null }),
    agencySubmission: () => ({
        status: "PENDING_REVIEW", candidateId: null, applicationId: null, note: null, reviewedById: null,
        reviewedAt: null, rejectionReason: null, ownershipExpiresAt: null, createdAt: new Date(), updatedAt: new Date(),
    }),
    candidate: () => ({ status: "active", notes: null, ownerAgencyId: null, ownershipExpiresAt: null, createdAt: new Date(), phone: null, parsedResume: null }),
    application: () => ({
        stage: "applied", status: "open", ownerAgencyId: null, ownershipExpiresAt: null, sourceDetail: null,
        appliedAt: new Date(), updatedAt: new Date(), dispositionReason: null,
    }),
    jobRequisition: () => ({ status: "APPROVED", closesAt: null, createdAt: new Date(), description: null, location: null, employmentType: null }),
};

export function makeAgencyDb() {
    const state = { tables: Object.fromEntries(MODELS.map((m) => [m, []])), ops: [], nextId: 5000 };

    const scope = (model, op) => {
        const store = mcpCtx.getStore();
        if (!store?.system && !store?.user?.tenantId) {
            throw Object.assign(new Error(`HR-4030: ${model}.${op} ran without a tenant context`), { code: "HR-4030", status: 403 });
        }
        const tenant = store.system ? null : store.user.tenantId;
        state.ops.push({ model, op, tenant: tenant ?? "SYSTEM" });
        return (row) => tenant == null || row.tenantId === tenant;
    };

    const related = (model, row, key) => {
        const rel = RELATIONS[model]?.[key];
        if (!rel) return undefined;
        const [kind, target, fk] = rel;
        const rows = state.tables[target];
        if (kind === "one") return rows.find((r) => r.id === row[fk]) ?? null;
        if (kind === "oneRev") return rows.find((r) => r[fk] === row.id) ?? null;
        return rows.filter((r) => r[fk] === row.id);
    };

    function condMatches(value, cond) {
        const v = value === undefined ? null : value;
        if (cond === null) return v === null;
        if (isDate(cond)) return num(v) === cond.getTime();
        if (typeof cond !== "object" || Array.isArray(cond)) return v === cond;
        const ci = cond.mode === "insensitive";
        for (const [op, arg] of Object.entries(cond)) {
            if (op === "mode") continue;
            if (op === "in" && !arg.map(num).includes(num(v))) return false;
            if (op === "notIn" && arg.map(num).includes(num(v))) return false;
            if (op === "not" && (arg === null ? v === null : num(v) === num(arg))) return false;
            if (op === "equals" && (ci ? lower(v) !== lower(arg) : num(v) !== num(arg))) return false;
            if (op === "contains" && !(typeof v === "string" && (ci ? lower(v).includes(lower(arg)) : v.includes(arg)))) return false;
            if (op === "lt" && !(v != null && num(v) < num(arg))) return false;
            if (op === "lte" && !(v != null && num(v) <= num(arg))) return false;
            if (op === "gt" && !(v != null && num(v) > num(arg))) return false;
            if (op === "gte" && !(v != null && num(v) >= num(arg))) return false;
        }
        return true;
    }

    function matches(model, row, where = {}) {
        return Object.entries(where ?? {}).every(([key, cond]) => {
            if (cond === undefined) return true;
            if (key === "AND") return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(model, row, w));
            if (key === "OR") return cond.some((w) => matches(model, row, w));
            if (key === "NOT") return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(model, row, w));
            const rel = RELATIONS[model]?.[key];
            if (rel) {
                const [kind, target] = rel;
                const value = related(model, row, key);
                if (kind === "many") {
                    if (cond.some) return value.some((r) => matches(target, r, cond.some));
                    if (cond.none) return !value.some((r) => matches(target, r, cond.none));
                    if (cond.every) return value.every((r) => matches(target, r, cond.every));
                    return true;
                }
                const inner = cond.is ?? cond;
                return value != null && matches(target, value, inner);
            }
            if (key.includes("_") && cond && typeof cond === "object" && !Array.isArray(cond) && !isDate(cond) && !(key in row)) {
                return matches(model, row, cond); // compound unique, e.g. tenantId_email
            }
            return condMatches(row[key], cond);
        });
    }

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

    function shape(model, row, { select, include, omit } = {}) {
        if (!row) return null;
        let out;
        if (select) {
            out = {};
            for (const [key, on] of Object.entries(select)) {
                if (!on) continue;
                if (RELATIONS[model]?.[key]) out[key] = resolveRel(model, row, key, on);
                else out[key] = clone(row[key]);
            }
            return out;
        }
        out = clone(row);
        for (const key of Object.keys(omit ?? {})) if (omit[key]) delete out[key];
        for (const [key, on] of Object.entries(include ?? {})) if (on) out[key] = resolveRel(model, row, key, on);
        return out;
    }

    function resolveRel(model, row, key, spec) {
        // A relation this fake does not model reads as absent.
        if (!RELATIONS[model]?.[key]) return null;
        const [kind, target] = RELATIONS[model][key];
        const opts = spec === true ? {} : spec;
        const value = related(model, row, key);
        if (kind === "many") {
            const list = sortRows(value.filter((r) => matches(target, r, opts.where)), opts.orderBy);
            return list.map((r) => shape(target, r, opts));
        }
        return value ? shape(target, value, opts) : null;
    }

    const applyData = (row, data) => {
        for (const [key, value] of Object.entries(clone(data))) {
            if (value && typeof value === "object" && !isDate(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
            else row[key] = value;
        }
        row.updatedAt = new Date();
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
        const visible = (vis, where) => rows().filter((r) => vis(r) && matches(model, r, where));
        const first = (op) => (args = {}) => lazy(() => {
            const vis = scope(model, op);
            return shape(model, sortRows(visible(vis, args.where), args.orderBy)[0] ?? null, args);
        });
        return {
            findFirst: first("findFirst"),
            findUnique: first("findUnique"),
            findMany: (args = {}) => lazy(() => {
                const vis = scope(model, "findMany");
                const skip = args.skip ?? 0;
                const list = sortRows(visible(vis, args.where), args.orderBy).slice(skip, args.take == null ? undefined : skip + args.take);
                return list.map((r) => shape(model, r, args));
            }),
            count: ({ where } = {}) => lazy(() => visible(scope(model, "count"), where).length),
            create: (args) => lazy(() => {
                scope(model, "create");
                const row = { id: state.nextId++, ...(DEFAULTS[model]?.() ?? {}), ...clone(args.data) };
                if (model === "recruitmentAgency" && rows().some((r) => r.tenantId === row.tenantId && r.name === row.name)) {
                    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                }
                if (model === "candidate" && rows().some((r) => r.tenantId === row.tenantId && r.email === row.email)) {
                    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                }
                if (model === "application" && rows().some((r) => r.candidateId === row.candidateId && r.jobRequisitionId === row.jobRequisitionId)) {
                    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                }
                rows().push(row);
                return shape(model, row, args);
            }),
            createMany: ({ data }) => lazy(() => {
                scope(model, "createMany");
                for (const d of data) rows().push({ id: state.nextId++, ...clone(d) });
                return { count: data.length };
            }),
            updateMany: ({ where, data }) => lazy(() => {
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
        try {
            return await fn(db);
        } catch (err) {
            state.tables = snapshot;
            throw err;
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
