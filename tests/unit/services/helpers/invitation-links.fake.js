// tests/unit/services/helpers/invitation-links.fake.js
//
// Recruitment Phase 6 — an in-memory stand-in for the models the invitation
// link code touches: talent pool invitations (with their candidate and
// requisition resolved at read time), candidates, requisitions and candidate
// communication rows. Like Prisma, every query is LAZY and reads the request
// context when awaited: a query outside mcpCtx fails (HR-4030) the way FORCE
// RLS would, a tenant context sees only its own rows, and every executed query
// is logged with its context. Where-clauses are evaluated for real (the
// scheduling fake's matcher), so the guarded claims are exercised, not mocked.
import { jest } from "@jest/globals";
import { mcpCtx } from "../../../../src/lib/requestContext.js";
import { matches } from "./interview-scheduling.fake.js";

const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function project(row, select) {
    if (!select || row == null) return clone(row);
    const out = {};
    for (const [key, sel] of Object.entries(select)) {
        if (!sel) continue;
        if (sel === true) out[key] = clone(row[key]);
        else if (sel.select) out[key] = row[key] == null ? null : project(row[key], sel.select);
        else out[key] = clone(row[key]);
    }
    return out;
}

function applyData(row, data) {
    for (const [key, value] of Object.entries(data ?? {})) {
        if (value && typeof value === "object" && !isDate(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
        else row[key] = isDate(value) ? new Date(value.getTime()) : clone(value);
    }
}

export function createInvitationLinksDb() {
    const state = { invitations: [], candidates: [], requisitions: [], communications: [] };
    const contextLog = [];
    let nextId = 5000;

    const hydrate = {
        invitations: (i) => ({
            ...i,
            candidate: state.candidates.find((c) => c.id === i.candidateId) ?? null,
            jobRequisition: state.requisitions.find((r) => r.id === i.jobRequisitionId) ?? null,
        }),
    };
    const visible = (table, ctx) => {
        const rows = state[table].map((r) => (hydrate[table] ? hydrate[table](r) : r));
        return ctx?.system ? rows : rows.filter((r) => r.tenantId === ctx.user.tenantId);
    };
    const lazy = (model, op, run) => {
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
    };

    const model = (name, table) => {
        const ops = {
            findFirst: ({ where, select } = {}) => lazy(name, "findFirst", (ctx) =>
                project(visible(table, ctx).find((r) => matches(r, where)) ?? null, select)),
            findUnique: ({ where, select } = {}) => lazy(name, "findUnique", (ctx) =>
                project(visible(table, ctx).find((r) => matches(r, where)) ?? null, select)),
            findMany: ({ where, select } = {}) => lazy(name, "findMany", (ctx) =>
                visible(table, ctx).filter((r) => matches(r, where)).map((r) => project(r, select))),
            create: ({ data, select } = {}) => lazy(name, "create", () => {
                const row = { id: nextId++, ...clone(data) };
                state[table].push(row);
                return project(row, select);
            }),
            createMany: ({ data, skipDuplicates } = {}) => lazy(name, "createMany", () => {
                let count = 0;
                for (const item of data) {
                    const clash = table === "communications"
                        && state.communications.some((r) => r.tenantId === item.tenantId && r.dedupeKey === item.dedupeKey);
                    if (clash && skipDuplicates) continue;
                    if (clash) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                    state[table].push({ id: nextId++, attempts: 0, claimedBy: null, claimExpiresAt: null, nextAttemptAt: null, ...clone(item) });
                    count += 1;
                }
                return { count };
            }),
            update: ({ where, data } = {}) => lazy(name, "update", (ctx) => {
                const ids = new Set(visible(table, ctx).filter((r) => matches(r, where)).map((r) => r.id));
                const row = state[table].find((r) => ids.has(r.id));
                if (!row) throw Object.assign(new Error("Record to update not found"), { code: "P2025" });
                applyData(row, data);
                return hydrate[table] ? hydrate[table](clone(row)) : clone(row);
            }),
            updateMany: ({ where, data } = {}) => lazy(name, "updateMany", (ctx) => {
                const ids = new Set(visible(table, ctx).filter((r) => matches(r, where)).map((r) => r.id));
                const rows = state[table].filter((r) => ids.has(r.id));
                for (const row of rows) applyData(row, data);
                return { count: rows.length };
            }),
        };
        return Object.fromEntries(Object.entries(ops).map(([op, fn]) => [op, jest.fn(fn)]));
    };

    const db = {
        talentPoolInvitation: model("talentPoolInvitation", "invitations"),
        candidate: model("candidate", "candidates"),
        jobRequisition: model("jobRequisition", "requisitions"),
        candidateCommunication: model("candidateCommunication", "communications"),
        $executeRaw: jest.fn(async () => 1),
        contextLog,
    };
    // A failed transaction rolls the state back.
    db.$transaction = jest.fn(async (fn) => {
        const snapshot = structuredClone(state);
        try {
            return await fn(db);
        } catch (err) {
            for (const key of Object.keys(state)) state[key] = snapshot[key];
            throw err;
        }
    });
    return { db, state };
}
