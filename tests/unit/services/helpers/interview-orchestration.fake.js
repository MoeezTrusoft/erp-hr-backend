// tests/unit/services/helpers/interview-orchestration.fake.js
//
// An in-memory stand-in for the prisma models the Phase 3a interview
// reminder, decision prompt and workspace services touch. Interviews are
// stored as the nested graph the services select (interviewers, scorecards,
// packetItems, application -> candidate / jobRequisition), so relation filters
// (`interviewers: { some }`, `application: { jobRequisition: ... }`,
// `reminders: { none }`) are evaluated for real; `select` and `include` are
// ignored and the whole row comes back.
//
// Like Prisma, every query is LAZY and reads the request context when awaited:
// a query outside a tenant or SYSTEM context fails the way FORCE RLS would
// (HR-4030), and every executed query is logged with its context.
import { jest } from "@jest/globals";
import { mcpCtx } from "../../../../src/lib/requestContext.js";
import { matches } from "../candidate-communication.fakes.js";

const clone = (row) => (row ? structuredClone(row) : null);
const uniqueError = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
const timeOf = (v) => (v instanceof Date ? v.getTime() : v);

function sortRows(rows, orderBy) {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o));
    if (!keys.length) return rows;
    return [...rows].sort((a, b) => {
        for (const [key, dir] of keys) {
            const left = timeOf(a[key]);
            const right = timeOf(b[key]);
            if (left === right) continue;
            const cmp = left == null ? -1 : right == null ? 1 : left < right ? -1 : 1;
            return dir === "desc" ? -cmp : cmp;
        }
        return 0;
    });
}

function lazy(contextLog, model, op, run) {
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
}

const lazyModel = (contextLog, model, methods) =>
    Object.fromEntries(
        Object.entries(methods).map(([op, impl]) => [op, jest.fn((args) => lazy(contextLog, model, op, () => impl(args ?? {})))]),
    );

function finder(rows) {
    return {
        findFirst: ({ where, orderBy }) => clone(sortRows(rows().filter((r) => matches(r, where)), orderBy)[0] ?? null),
        findMany: ({ where, orderBy, skip = 0, take }) =>
            sortRows(rows().filter((r) => matches(r, where)), orderBy)
                .slice(skip, take != null ? skip + take : undefined)
                .map(clone),
        count: ({ where }) => rows().filter((r) => matches(r, where)).length,
        groupBy: ({ by, where }) => {
            const groups = new Map();
            for (const row of rows().filter((r) => matches(r, where))) {
                const key = JSON.stringify(by.map((k) => row[k]));
                const group = groups.get(key) ?? { ...Object.fromEntries(by.map((k) => [k, row[k]])), _count: { _all: 0 } };
                group._count._all += 1;
                groups.set(key, group);
            }
            return [...groups.values()];
        },
    };
}

export function createInterviewFakeDb() {
    const store = {
        interviews: [],
        reminders: [],
        outbox: [],
        applications: [],
        requisitions: [],
        shortlist: [],
        offers: [],
        history: [],
    };
    const contextLog = [];
    let nextId = 1000;

    // Interviews carry their reminder rows as a virtual relation.
    const interviewRows = () =>
        store.interviews.map((row) => ({ ...row, reminders: store.reminders.filter((r) => r.interviewId === row.id) }));
    const rawInterview = (where) => store.interviews.filter((r) => matches({ ...r, reminders: [] }, where));
    const scorecards = () => store.interviews.flatMap((i) => (i.scorecards || []).map((c) => ({ ...c, interviewId: i.id })));

    const reminderClash = (data) =>
        store.reminders.some((r) => r.interviewId === data.interviewId && r.kind === data.kind && r.recipientKey === data.recipientKey);

    const db = {
        interview: lazyModel(contextLog, "interview", {
            ...finder(interviewRows),
            update: ({ where, data }) => {
                const row = store.interviews.find((r) => r.id === where.id);
                Object.assign(row, structuredClone(data));
                return clone(row);
            },
            updateMany: ({ where, data }) => {
                const hit = rawInterview(where);
                for (const row of hit) Object.assign(row, structuredClone(data));
                return { count: hit.length };
            },
        }),
        interviewReminder: lazyModel(contextLog, "interviewReminder", {
            ...finder(() => store.reminders),
            create: ({ data }) => {
                if (reminderClash(data)) throw uniqueError();
                const row = { id: nextId++, ...structuredClone(data) };
                store.reminders.push(row);
                return clone(row);
            },
            createMany: ({ data, skipDuplicates }) => {
                let count = 0;
                for (const item of data) {
                    if (reminderClash(item)) {
                        if (skipDuplicates) continue;
                        throw uniqueError();
                    }
                    store.reminders.push({ id: nextId++, ...structuredClone(item) });
                    count += 1;
                }
                return { count };
            },
            deleteMany: ({ where }) => {
                const before = store.reminders.length;
                store.reminders = store.reminders.filter((r) => !matches(r, where));
                return { count: before - store.reminders.length };
            },
        }),
        interviewScorecard: lazyModel(contextLog, "interviewScorecard", {
            ...finder(scorecards),
            findUnique: ({ where }) => {
                const key = where.interviewId_reviewerId;
                return clone(scorecards().find((c) => c.interviewId === key.interviewId && c.reviewerId === key.reviewerId) ?? null);
            },
            create: ({ data }) => {
                const interview = store.interviews.find((i) => i.id === data.interviewId);
                const row = { id: nextId++, ...structuredClone(data) };
                interview.scorecards = [...(interview.scorecards || []), row];
                return clone(row);
            },
            update: ({ where, data }) => {
                const card = store.interviews.flatMap((i) => i.scorecards || []).find((c) => c.id === where.id);
                Object.assign(card, structuredClone(data));
                return clone(card);
            },
        }),
        application: lazyModel(contextLog, "application", finder(() => store.applications)),
        jobRequisition: lazyModel(contextLog, "jobRequisition", finder(() => store.requisitions)),
        shortlistEntry: lazyModel(contextLog, "shortlistEntry", finder(() => store.shortlist)),
        offer: lazyModel(contextLog, "offer", finder(() => store.offers)),
        outboxEvent: lazyModel(contextLog, "outboxEvent", {
            create: ({ data }) => {
                const row = { id: `outbox-${store.outbox.length + 1}`, ...data };
                store.outbox.push(row);
                return row;
            },
        }),
        $executeRaw: jest.fn(async () => 1),
        contextLog,
    };
    db.$transaction = jest.fn(async (arg) => (typeof arg === "function" ? arg(db) : Promise.all(arg)));
    return { db, store };
}

/** The payloads of the outbox rows with this event name. */
export const eventsNamed = (store, name) => store.outbox.filter((row) => row.eventName === name).map((row) => row.payload.payload);
