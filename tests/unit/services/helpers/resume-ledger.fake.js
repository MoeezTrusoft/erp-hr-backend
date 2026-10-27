// tests/unit/services/helpers/resume-ledger.fake.js
//
// An in-memory stand-in for the parts of the Prisma client the resume parse
// queue and worker use: resume_parse_attempts (with its (tenantId, kind,
// contentHash) unique key), Candidate, CandidateSkill and AiInferenceRecord.
//
// Two behaviours of the real client matter for these tests and are kept:
//   * queries are LAZY: nothing runs until the query is awaited, and the
//     request context is read at that moment. A query returned unawaited from
//     an mcpCtx.run callback therefore runs outside the context and fails with
//     HR-4030, as it would against the real tenant-scope extension;
//   * a tenant context only sees its own tenant's rows (the RLS policy), so a
//     cross-tenant leak in the code under test shows up as a miss.
import { Prisma } from "@prisma/client";

import { mcpCtx } from "../../../../src/lib/requestContext.js";

const time = (v) => (v == null ? null : new Date(v).getTime());

export function matches(row, where) {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
        if (cond === undefined) continue;
        if (key === "OR") {
            if (!cond.some((w) => matches(row, w))) return false;
            continue;
        }
        if (key === "AND") {
            if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w))) return false;
            continue;
        }
        if (key === "NOT") {
            if ((Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w))) return false;
            continue;
        }
        if (key === "tenantId_kind_contentHash" || key === "candidateId_name") {
            if (!matches(row, cond)) return false;
            continue;
        }
        const value = row[key];
        if (cond instanceof Date) {
            if (time(value) !== cond.getTime()) return false;
        } else if (cond !== null && typeof cond === "object") {
            if ("not" in cond && !(cond.not === null ? value != null : value !== cond.not)) return false;
            if ("in" in cond && !cond.in.includes(value)) return false;
            if ("lte" in cond && !(value != null && time(value) <= time(cond.lte))) return false;
            if ("lt" in cond && !(value != null && time(value) < time(cond.lt))) return false;
            if ("gt" in cond && !(value != null && time(value) > time(cond.gt))) return false;
            if ("startsWith" in cond && !String(value ?? "").startsWith(cond.startsWith)) return false;
            if ("contains" in cond && !String(value ?? "").includes(cond.contains)) return false;
        } else if ((value ?? null) !== cond) {
            return false;
        }
    }
    return true;
}

const clone = (row) => (row ? structuredClone(row) : row);

function applyData(row, data, now) {
    for (const [key, value] of Object.entries(data)) {
        if (value === Prisma.DbNull || value === Prisma.JsonNull) row[key] = null;
        else if (value && typeof value === "object" && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
        else row[key] = value instanceof Date ? new Date(value) : structuredClone(value);
    }
    row.updatedAt = now();
}

export function makeFakeDb({ now = () => new Date() } = {}) {
    const state = { attempts: [], candidates: [], skills: [], inferences: [], ops: [], nextId: 1 };

    // Read the context when the query RUNS (await time), not when it is built.
    const scope = (model, op) => {
        const store = mcpCtx.getStore();
        if (!store?.system && !store?.user?.tenantId) {
            throw Object.assign(new Error(`HR-4030: ${model}.${op} ran without a tenant context`), { code: "HR-4030" });
        }
        const tenant = store.system ? null : store.user.tenantId;
        state.ops.push({ model, op, tenant: tenant ?? "SYSTEM" });
        return (row) => tenant == null || row.tenantId === tenant;
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
    const keyOf = (r) => `${r.tenantId}|${r.kind}|${r.contentHash}`;
    const assertUnique = (rows, changed) => {
        if (rows.filter((r) => keyOf(r) === keyOf(changed)).length > 1) throw conflict();
    };

    const table = (name, rows, { unique } = {}) => ({
        findMany: ({ where, take, orderBy } = {}) =>
            lazy(() => {
                const visible = scope(name, "findMany");
                let out = rows().filter(visible).filter((r) => matches(r, where));
                if (orderBy) {
                    out = out.sort((a, b) => {
                        const at = time(a.nextAttemptAt) ?? Infinity;
                        const bt = time(b.nextAttemptAt) ?? Infinity;
                        return at - bt || a.id - b.id;
                    });
                }
                return out.slice(0, take ?? out.length).map(clone);
            }),
        findFirst: ({ where } = {}) =>
            lazy(() => {
                const visible = scope(name, "findFirst");
                return clone(rows().filter(visible).find((r) => matches(r, where)) ?? null);
            }),
        findUnique: ({ where } = {}) =>
            lazy(() => {
                const visible = scope(name, "findUnique");
                return clone(rows().filter(visible).find((r) => matches(r, where)) ?? null);
            }),
        updateMany: ({ where, data }) =>
            lazy(() => {
                const visible = scope(name, "updateMany");
                const hit = rows().filter(visible).filter((r) => matches(r, where));
                for (const row of hit) {
                    const before = clone(row);
                    applyData(row, data, now);
                    try {
                        if (unique) assertUnique(rows(), row);
                    } catch (err) {
                        Object.assign(row, before);
                        throw err;
                    }
                }
                return { count: hit.length };
            }),
        deleteMany: ({ where }) =>
            lazy(() => {
                const visible = scope(name, "deleteMany");
                const hit = rows().filter(visible).filter((r) => matches(r, where));
                for (const row of hit) rows().splice(rows().indexOf(row), 1);
                return { count: hit.length };
            }),
        delete: ({ where }) =>
            lazy(() => {
                const visible = scope(name, "delete");
                const row = rows().filter(visible).find((r) => matches(r, where));
                if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
                rows().splice(rows().indexOf(row), 1);
                return clone(row);
            }),
        create: ({ data }) =>
            lazy(() => {
                scope(name, "create");
                const row = { id: state.nextId++, startedAt: now(), updatedAt: now(), ...defaults(name) };
                applyData(row, data, now);
                if (unique && rows().some((r) => keyOf(r) === keyOf(row))) throw conflict();
                rows().push(row);
                return clone(row);
            }),
        upsert: ({ where, create, update }) =>
            lazy(() => {
                const visible = scope(name, "upsert");
                const row = rows().filter(visible).find((r) => matches(r, where));
                if (row) {
                    applyData(row, update, now);
                    return clone(row);
                }
                const created = { id: state.nextId++, startedAt: now(), updatedAt: now(), ...defaults(name) };
                applyData(created, create, now);
                rows().push(created);
                return clone(created);
            }),
    });

    const defaults = (name) =>
        name === "resumeParseAttempt"
            ? { status: "PENDING", attemptCount: 0, lastError: null, parsedJson: null, candidateId: null, mediaId: null, nextAttemptAt: null, claimedBy: null, claimExpiresAt: null }
            : {};

    const db = {
        state,
        resumeParseAttempt: table("resumeParseAttempt", () => state.attempts, { unique: true }),
        candidate: table("candidate", () => state.candidates),
        candidateSkill: table("candidateSkill", () => state.skills),
        aiInferenceRecord: { create: ({ data }) => lazy(() => (state.inferences.push(data), data)) },
    };
    return db;
}

export const seedCandidate = (db, { id, tenantId, resumeMediaId = null }) => {
    db.state.candidates.push({ id, tenantId, resumeMediaId, parseStatus: null, parseError: null, parsedAt: null, parsedResume: null });
};

export const candidateOf = (db, id) => db.state.candidates.find((c) => c.id === id);
