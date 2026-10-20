// tests/unit/services/helpers/onsite-test.fake.js
//
// An in-memory stand-in for the Prisma client parts the Phase 3b reception,
// kiosk session and result services use. What it keeps from the real client:
//   * LAZY queries: nothing runs until awaited, and the request context is
//     read at that moment, so a query returned unawaited from an mcpCtx.run
//     callback fails with HR-4030 as it would against the tenant scope;
//   * a tenant context sees only its own tenant's rows (the RLS policy);
//   * `select` is honoured (top level and relations), so a test can assert a
//     column such as answerKey never left the database;
//   * $transaction rolls the whole state back when its callback throws, and
//     every operation records which transaction it ran on.
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const time = (v) => (v instanceof Date ? v.getTime() : v == null ? null : new Date(v).getTime());
const isDateLike = (v) => v instanceof Date;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

// model -> relation name -> { model, kind, local, foreign }
const RELATIONS = {
    interview: {
        interviewers: { model: "interviewInterviewer", kind: "many", local: "id", foreign: "interviewId" },
        application: { model: "application", kind: "one", local: "applicationId", foreign: "id" },
    },
    application: {
        jobRequisition: { model: "jobRequisition", kind: "one", local: "jobRequisitionId", foreign: "id" },
        candidate: { model: "candidate", kind: "one", local: "candidateId", foreign: "id" },
        interviews: { model: "interview", kind: "many", local: "id", foreign: "applicationId" },
    },
};

const UNIQUES = {
    candidateCheckIn: [["interviewId"]],
    candidateTestResult: [["sessionId"]],
    candidateTestResponse: [["sessionId", "itemId"]],
    candidateTestSession: [["sessionCodeHash"], ["sessionTokenHash"]],
    dispositionReasonCode: [["tenantId", "code", "version"]],
    tenantRecruitmentSettings: [["tenantId"]],
};

const DEFAULTS = {
    candidateTestSession: () => ({
        status: "ISSUED", attemptNo: 1, pausedTotalSec: 0, extraTimePct: 0, issuedAt: new Date(), startedAt: null,
        deadlineAt: null, pausedAt: null, submittedAt: null, submitReason: null, voidedAt: null, voidReason: null,
        itemOrder: null, lastHeartbeatAt: null, consentAt: null, practiceDoneAt: null, sessionCodeHash: null,
        sessionTokenHash: null, codeExpiresAt: null, workstationId: null, siteRef: null, checkInId: null, previousSessionId: null,
    }),
    candidateTestResponse: () => ({ flagged: false, timeSpentSec: 0, answeredAt: new Date() }),
    candidateTestIntegrityEvent: () => ({ source: "KIOSK", occurredAt: new Date(), detail: null }),
    candidateTestResult: () => ({
        mustPassFailed: false, integrityFlagCount: 0, percentile: null, decision: null, decidedById: null,
        decisionReason: null, decidedAt: null, validUntil: null, timeTakenSec: null, createdAt: new Date(),
    }),
    candidateCheckIn: () => ({ arrivedAt: new Date(), accommodations: null, accommodationReason: null }),
    interview: () => ({ assessmentRequired: false, assessmentStatus: "NOT_REQUIRED", status: "SCHEDULED" }),
};

function condMatches(value, cond) {
    if (cond === null) return value === null || value === undefined;
    if (isDateLike(cond)) return time(value) === cond.getTime();
    if (typeof cond !== "object" || Array.isArray(cond)) return (value ?? null) === cond;
    const insensitive = cond.mode === "insensitive";
    const norm = (v) => (insensitive && typeof v === "string" ? v.toLowerCase() : v);
    for (const [op, arg] of Object.entries(cond)) {
        if (op === "mode") continue;
        if (op === "equals" && norm(value ?? null) !== norm(arg)) return false;
        if (op === "not") {
            if (arg === null ? value === null || value === undefined : condMatches(value, arg)) return false;
        }
        if (op === "in" && !arg.map(norm).includes(norm(value))) return false;
        if (op === "notIn" && arg.map(norm).includes(norm(value))) return false;
        if (op === "lt" && !(value != null && time(value) < time(arg))) return false;
        if (op === "lte" && !(value != null && time(value) <= time(arg))) return false;
        if (op === "gt" && !(value != null && time(value) > time(arg))) return false;
        if (op === "gte" && !(value != null && time(value) >= time(arg))) return false;
        if (op === "contains" && !String(norm(value) ?? "").includes(norm(arg))) return false;
    }
    return true;
}

export function makeOnsiteDb() {
    const state = { tables: {}, ops: [], nextId: 5000, txSeq: 0 };
    const rows = (model) => (state.tables[model] ??= []);
    let activeTx = null;

    const related = (model, row, name) => {
        const rel = RELATIONS[model]?.[name];
        if (!rel) return undefined;
        const list = rows(rel.model).filter((r) => r[rel.foreign] === row[rel.local]);
        return { rel, value: rel.kind === "one" ? list[0] ?? null : list };
    };

    function matches(model, row, where) {
        if (!where) return true;
        for (const [key, cond] of Object.entries(where)) {
            if (cond === undefined) continue;
            if (key === "OR") {
                if (!cond.some((w) => matches(model, row, w))) return false;
                continue;
            }
            if (key === "AND") {
                if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matches(model, row, w))) return false;
                continue;
            }
            if (key === "NOT") {
                if ((Array.isArray(cond) ? cond : [cond]).some((w) => matches(model, row, w))) return false;
                continue;
            }
            const rel = related(model, row, key);
            if (rel) {
                if (rel.rel.kind === "many") {
                    if (cond.some && !rel.value.some((r) => matches(rel.rel.model, r, cond.some))) return false;
                    if (cond.none && rel.value.some((r) => matches(rel.rel.model, r, cond.none))) return false;
                } else {
                    const inner = cond.is ?? cond;
                    if (!rel.value || !matches(rel.rel.model, rel.value, inner)) return false;
                }
                continue;
            }
            // compound unique key: { sessionId_itemId: { sessionId, itemId } }
            if (key.includes("_") && cond && typeof cond === "object" && !isDateLike(cond) && !(key in row)) {
                if (!matches(model, row, cond)) return false;
                continue;
            }
            if (!condMatches(row[key], cond)) return false;
        }
        return true;
    }

    function project(model, row, select, include) {
        if (!row) return row;
        if (!select) {
            const out = clone(row);
            for (const [name, spec] of Object.entries(include ?? {})) {
                const rel = related(model, row, name);
                if (!rel) continue;
                const sub = spec === true ? {} : spec;
                out[name] = rel.rel.kind === "many"
                    ? rel.value.map((r) => project(rel.rel.model, r, sub.select, sub.include))
                    : project(rel.rel.model, rel.value, sub.select, sub.include);
            }
            return out;
        }
        const out = {};
        for (const [name, spec] of Object.entries(select)) {
            if (!spec) continue;
            const rel = related(model, row, name);
            if (rel) {
                const sub = spec === true ? {} : spec;
                out[name] = rel.rel.kind === "many"
                    ? rel.value.map((r) => project(rel.rel.model, r, sub.select, sub.include))
                    : project(rel.rel.model, rel.value, sub.select, sub.include);
            } else {
                out[name] = clone(row[name]);
            }
        }
        return out;
    }

    // Read the context when the query RUNS (await time), not when it is built.
    const scope = (model, op) => {
        const store = mcpCtx.getStore();
        if (!store?.system && !store?.user?.tenantId) {
            throw Object.assign(new Error(`HR-4030: ${model}.${op} ran without a tenant context`), { code: "HR-4030", status: 403 });
        }
        const tenant = store.system ? null : store.user.tenantId;
        state.ops.push({ model, op, tenant: tenant ?? "SYSTEM", tx: activeTx });
        return (row) => tenant == null || !("tenantId" in row) || row.tenantId === tenant;
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

    const conflict = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    function assertUnique(model, row) {
        for (const fields of UNIQUES[model] ?? []) {
            if (fields.some((f) => row[f] === null || row[f] === undefined)) continue;
            const dupes = rows(model).filter((r) => fields.every((f) => r[f] === row[f]));
            if (dupes.length > 1) throw conflict();
        }
    }

    function applyData(model, row, data) {
        for (const [key, value] of Object.entries(data ?? {})) {
            if (value === undefined) continue;
            if (value && typeof value === "object" && !isDateLike(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
            else row[key] = isDateLike(value) ? new Date(value) : clone(value);
        }
        row.updatedAt = new Date();
    }

    const sortRows = (list, orderBy) => {
        const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o));
        if (!specs.length) return list;
        return [...list].sort((a, b) => {
            for (const [field, dir] of specs) {
                const av = isDateLike(a[field]) ? a[field].getTime() : a[field];
                const bv = isDateLike(b[field]) ? b[field].getTime() : b[field];
                if (av === bv) continue;
                const cmp = av == null ? -1 : bv == null ? 1 : av < bv ? -1 : 1;
                return dir === "desc" ? -cmp : cmp;
            }
            return 0;
        });
    };

    const table = (model) => ({
        findMany: ({ where, select, include, orderBy, take, skip } = {}) =>
            lazy(() => {
                const visible = scope(model, "findMany");
                const list = sortRows(rows(model).filter(visible).filter((r) => matches(model, r, where)), orderBy);
                return list.slice(skip ?? 0, (skip ?? 0) + (take ?? list.length)).map((r) => project(model, r, select, include));
            }),
        findFirst: ({ where, select, include, orderBy } = {}) =>
            lazy(() => {
                const visible = scope(model, "findFirst");
                const list = sortRows(rows(model).filter(visible).filter((r) => matches(model, r, where)), orderBy);
                return project(model, list[0] ?? null, select, include);
            }),
        findUnique: ({ where, select, include } = {}) =>
            lazy(() => {
                const visible = scope(model, "findUnique");
                return project(model, rows(model).filter(visible).find((r) => matches(model, r, where)) ?? null, select, include);
            }),
        count: ({ where } = {}) =>
            lazy(() => {
                const visible = scope(model, "count");
                return rows(model).filter(visible).filter((r) => matches(model, r, where)).length;
            }),
        create: ({ data, select }) =>
            lazy(() => {
                scope(model, "create");
                const row = { id: state.nextId++, createdAt: new Date(), ...(DEFAULTS[model]?.() ?? {}) };
                applyData(model, row, data);
                rows(model).push(row);
                try {
                    assertUnique(model, row);
                } catch (err) {
                    rows(model).pop();
                    throw err;
                }
                return project(model, row, select);
            }),
        createMany: ({ data, skipDuplicates }) =>
            lazy(() => {
                scope(model, "createMany");
                let count = 0;
                for (const item of Array.isArray(data) ? data : [data]) {
                    const row = { id: state.nextId++, createdAt: new Date(), ...(DEFAULTS[model]?.() ?? {}) };
                    applyData(model, row, item);
                    rows(model).push(row);
                    try {
                        assertUnique(model, row);
                        count += 1;
                    } catch (err) {
                        rows(model).pop();
                        if (!skipDuplicates) throw err;
                    }
                }
                return { count };
            }),
        update: ({ where, data, select }) =>
            lazy(() => {
                const visible = scope(model, "update");
                const row = rows(model).filter(visible).find((r) => matches(model, r, where));
                if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
                applyData(model, row, data);
                assertUnique(model, row);
                return project(model, row, select);
            }),
        updateMany: ({ where, data }) =>
            lazy(() => {
                const visible = scope(model, "updateMany");
                const hit = rows(model).filter(visible).filter((r) => matches(model, r, where));
                for (const row of hit) applyData(model, row, data);
                return { count: hit.length };
            }),
        upsert: ({ where, create, update }) =>
            lazy(() => {
                const visible = scope(model, "upsert");
                const row = rows(model).filter(visible).find((r) => matches(model, r, where));
                if (row) {
                    applyData(model, row, update);
                    return clone(row);
                }
                const created = { id: state.nextId++, createdAt: new Date(), ...(DEFAULTS[model]?.() ?? {}) };
                applyData(model, created, create);
                rows(model).push(created);
                assertUnique(model, created);
                return clone(created);
            }),
        deleteMany: ({ where } = {}) =>
            lazy(() => {
                const visible = scope(model, "deleteMany");
                const hit = rows(model).filter(visible).filter((r) => matches(model, r, where));
                state.tables[model] = rows(model).filter((r) => !hit.includes(r));
                return { count: hit.length };
            }),
    });

    const db = new Proxy(
        {
            state,
            rows,
            $executeRaw: () => lazy(() => 1),
            async $transaction(fn) {
                if (typeof fn !== "function") return Promise.all(fn);
                const outer = activeTx;
                const snapshot = outer ? null : clone(state.tables);
                const txId = ++state.txSeq;
                activeTx = txId;
                const tx = new Proxy({ txId }, { get: (target, prop) => (prop in target ? target[prop] : db[prop]) });
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
    const enqueueHrDomainEvent = async (_tx, event) => {
        if (event) events.push(event);
        return event;
    };
    return { events, enqueueHrDomainEvent, named: (name) => events.filter((e) => e.eventName === `hr.recruitment.${name}.v1`) };
}
