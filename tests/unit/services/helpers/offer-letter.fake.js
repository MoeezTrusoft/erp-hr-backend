// tests/unit/services/helpers/offer-letter.fake.js
//
// An in-memory stand-in for the Prisma models the offer letter and e-sign
// services touch: offers, offer_letter_templates, offer_letter_versions and
// esign_webhook_events, with their unique keys.
//
// Kept from the real client, because the tests depend on them:
//   * LAZY queries. Nothing runs until awaited, and the request context is
//     read then: a query awaited outside mcpCtx fails with HR-4030.
//   * RLS. A tenant context sees only its tenant's rows; SYSTEM sees all.
//     Every query is logged with the context it ran under (contextLog).
//   * UNIQUE KEYS raise P2002, so version races and webhook dedupe are real.
import { jest } from "@jest/globals";

import { matches } from "../candidate-communication.fakes.js";
import { mcpCtx } from "../../../../src/lib/requestContext.js";

const UNIQUE = {
    offerLetterTemplate: [["tenantId", "key", "version"]],
    offerLetterVersion: [["offerId", "version"], ["esignProvider", "esignEnvelopeId"]],
    esignWebhookEvent: [["provider", "providerEventId"]],
    offer: [],
};

const clone = (row) => (row ? structuredClone(row) : null);

function sortRows(rows, orderBy) {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o));
    if (!keys.length) return rows;
    return [...rows].sort((a, b) => {
        for (const [field, dir] of keys) {
            const x = a[field] instanceof Date ? a[field].getTime() : a[field];
            const y = b[field] instanceof Date ? b[field].getTime() : b[field];
            if (x === y) continue;
            const cmp = x > y ? 1 : -1;
            return dir === "desc" ? -cmp : cmp;
        }
        return 0;
    });
}

export function createOfferLetterDb() {
    const store = { offer: [], offerLetterTemplate: [], offerLetterVersion: [], esignWebhookEvent: [] };
    const contextLog = [];
    let nextId = 1000;

    const visible = (rows) => {
        const ctx = mcpCtx.getStore();
        if (ctx?.system) return rows;
        const tenantId = ctx?.user?.tenantId;
        return rows.filter((r) => !("tenantId" in r) || r.tenantId === tenantId);
    };

    const lazy = (model, op, run) => {
        let promise = null;
        const execute = () => {
            if (!promise) {
                const ctx = mcpCtx.getStore();
                contextLog.push({ model, op, system: Boolean(ctx?.system), tenantId: ctx?.user?.tenantId ?? null });
                promise = ctx?.system || ctx?.user?.tenantId
                    ? Promise.resolve().then(run)
                    : Promise.reject(Object.assign(new Error(`RLS: ${model}.${op} ran outside a tenant context`), { code: "HR-4030" }));
            }
            return promise;
        };
        return {
            then: (ok, err) => execute().then(ok, err),
            catch: (err) => execute().catch(err),
            finally: (fn) => execute().finally(fn),
        };
    };

    const clash = (model, row, self = null) =>
        UNIQUE[model].some((fields) =>
            fields.every((f) => row[f] != null) &&
            store[model].some((other) => other !== self && fields.every((f) => other[f] === row[f])),
        );

    const model = (name, defaults = () => ({})) => {
        const rows = () => visible(store[name]);
        const impl = {
            findFirst: ({ where, orderBy } = {}) => clone(sortRows(rows().filter((r) => matches(r, where)), orderBy)[0] ?? null),
            findUnique: ({ where } = {}) => clone(rows().find((r) => matches(r, where)) ?? null),
            findMany: ({ where, orderBy, take } = {}) =>
                sortRows(rows().filter((r) => matches(r, where)), orderBy).slice(0, take ?? undefined).map(clone),
            count: ({ where } = {}) => rows().filter((r) => matches(r, where)).length,
            create: ({ data }) => {
                const row = { id: nextId++, ...defaults(), ...structuredClone(data) };
                if (clash(name, row)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                store[name].push(row);
                return clone(row);
            },
            updateMany: ({ where, data }) => {
                const hit = rows().filter((r) => matches(r, where));
                for (const row of hit) {
                    const next = { ...row, ...structuredClone(data) };
                    if (clash(name, next, row)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                    Object.assign(row, structuredClone(data));
                }
                return { count: hit.length };
            },
            update: ({ where, data }) => {
                const row = rows().find((r) => matches(r, where));
                if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
                Object.assign(row, structuredClone(data));
                return clone(row);
            },
        };
        return Object.fromEntries(Object.entries(impl).map(([op, fn]) => [op, jest.fn((args) => lazy(name, op, () => fn(args)))]));
    };

    const db = {
        offer: model("offer"),
        offerLetterTemplate: model("offerLetterTemplate", () => ({ active: true, createdAt: new Date("2026-10-01T00:00:00Z") })),
        offerLetterVersion: model("offerLetterVersion", () => ({
            createdAt: new Date(),
            signatureStatus: "NONE",
            esignProvider: null,
            esignEnvelopeId: null,
            sentForSignatureAt: null,
            signedAt: null,
            signedMediaId: null,
            signatureError: null,
        })),
        esignWebhookEvent: model("esignWebhookEvent", () => ({
            tenantId: null,
            status: "RECEIVED",
            error: null,
            receivedAt: new Date(),
            processedAt: null,
        })),
        $queryRaw: jest.fn(async () => []),
        $executeRaw: jest.fn(async () => 1),
        contextLog,
    };
    db.$transaction = jest.fn(async (arg) => (typeof arg === "function" ? arg(db) : Promise.all(arg)));
    return { db, store };
}
