// tests/unit/services/offer-expiry.service.test.js
//
// Recruitment Phase 3a — the offer expiry sweep and the recruiter's extension.
//
// Pinned: the flag gates the sweep only; reminders go out once inside the
// tenant's window and are stamped in the same transaction as their event;
// expiry is a conditional SENT -> EXPIRED claim (idempotent, and the
// application is never rejected); one row or tenant failing never stops the
// rest; queries run under the right context at await time. Extension: ORG only,
// future and at most 60 days ahead, later than the current date; an EXPIRED
// offer is reopened only within 7 days while its requisition is open; the write
// runs under the approval's finalizing marker.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { matches } from "./helpers/resume-ledger.fake.js";
import { mcpCtx } from "../../../src/lib/requestContext.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days) => new Date(NOW.getTime() + days * DAY);

let OFFERS = [];
let OUTBOX = [];
let APPROVALS = [];
let OPS = [];
let RAW = [];
let failEnqueueFor = null;

// A local deep copy: structuredClone hands back Dates from another realm under
// the jest VM, which `instanceof Date` (and so the matcher) would not see.
const clone = (value) => {
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
    return value;
};

// Read the context when the query RUNS, as the real client does.
const scope = (model, op) => {
    const store = mcpCtx.getStore();
    if (!store?.system && !store?.user?.tenantId) {
        throw Object.assign(new Error(`HR-4030: ${model}.${op} ran without a tenant context`), { code: "HR-4030" });
    }
    const tenant = store.system ? null : store.user.tenantId;
    OPS.push({ model, op, tenant: tenant ?? "SYSTEM", tx: store.tx === true });
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
const applyData = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
        else row[key] = value instanceof Date ? new Date(value) : value;
    }
};

const prisma = {
    offer: {
        findMany: jest.fn(({ where, take, distinct } = {}) =>
            lazy(() => {
                const visible = scope("offer", "findMany");
                let rows = OFFERS.filter(visible).filter((r) => matches(r, where));
                if (distinct?.includes("tenantId")) rows = [...new Map(rows.map((r) => [r.tenantId, r])).values()];
                return rows.slice(0, take ?? rows.length).map(clone);
            }),
        ),
        findFirst: jest.fn(({ where } = {}) =>
            lazy(() => {
                const visible = scope("offer", "findFirst");
                return clone(OFFERS.filter(visible).find((r) => matches(r, where)) ?? null);
            }),
        ),
        updateMany: jest.fn(({ where, data }) =>
            lazy(() => {
                const visible = scope("offer", "updateMany");
                const hit = OFFERS.filter(visible).filter((r) => matches(r, where));
                hit.forEach((row) => applyData(row, data));
                return { count: hit.length };
            }),
        ),
    },
    application: { update: jest.fn(), updateMany: jest.fn() },
    hrApprovalRequest: {
        findUnique: jest.fn(({ where }) =>
            lazy(() => {
                const key = where.tenantId_kind_sourceRef;
                return clone(APPROVALS.find((a) => a.tenantId === key.tenantId && a.kind === key.kind && a.sourceRef === key.sourceRef) ?? null);
            }),
        ),
    },
    outboxEvent: {
        create: jest.fn(async ({ data }) => {
            if (failEnqueueFor != null && data.aggregateId === String(failEnqueueFor)) throw new Error("outbox down");
            const row = { id: OUTBOX.length + 1, ...data };
            OUTBOX.push(row);
            return row;
        }),
    },
    $queryRaw: jest.fn(async (strings, ...values) => {
        RAW.push({ sql: strings.join("?"), values });
        return [];
    }),
    $executeRaw: jest.fn(async (strings, ...values) => {
        RAW.push({ sql: strings.join("?"), values });
        return 1;
    }),
};

const tenantTransaction = jest.fn(async (client, fn, opts = {}) =>
    mcpCtx.run({ ...(mcpCtx.getStore() ?? {}), tx: true, txTenant: opts.tenantId }, async () => await fn(client)),
);
const getRecruitmentSettings = jest.fn(async () => ({ offerReminderDays: 3 }));
const assertCommunicationsAllowed = jest.fn(async () => ({ allowed: true }));

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({ tenantTransaction, rlsTenantExtension: (c) => c }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({ assertCommunicationsAllowed }));

const {
    runOfferExpiryJob,
    extendOfferExpiry,
    OFFER_EXPIRED_EVENT,
    OFFER_EXPIRY_REMINDER_EVENT,
    OFFER_EXPIRY_EXTENDED_EVENT,
} = await import("../../../src/services/offer-expiry.service.js");

const offer = (over = {}) => ({
    id: 1,
    tenantId: T1,
    applicationId: 10,
    candidateId: 20,
    jobRequisitionId: 30,
    status: "SENT",
    expiryDate: at(2),
    expiryReminderSentAt: null,
    expiredAt: null,
    expiryExtendedCount: 0,
    createdById: 7,
    version: 3,
    salary: 100000,
    jobRequisition: { recruiterId: 8, status: "POSTED" },
    application: { stage: "offer" },
    ...over,
});
const events = (name) => OUTBOX.filter((o) => o.eventName === name);
const byId = (id) => OFFERS.find((o) => o.id === id);

beforeEach(() => {
    jest.clearAllMocks();
    OFFERS = [];
    OUTBOX = [];
    APPROVALS = [];
    OPS = [];
    RAW = [];
    failEnqueueFor = null;
    process.env.HR_RECRUITMENT_OFFER_EXPIRY = "true";
    getRecruitmentSettings.mockImplementation(async () => ({ offerReminderDays: 3 }));
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_OFFER_EXPIRY;
});

describe("runOfferExpiryJob — flag", () => {
    it("does nothing while offerExpiry is off", async () => {
        delete process.env.HR_RECRUITMENT_OFFER_EXPIRY;
        OFFERS = [offer({ expiryDate: at(-1) })];
        expect(await runOfferExpiryJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
        expect(prisma.offer.findMany).not.toHaveBeenCalled();
        expect(byId(1).status).toBe("SENT");
    });
});

describe("runOfferExpiryJob — reminders", () => {
    it("reminds once inside the window, stamps in the same transaction, and skips the rest", async () => {
        OFFERS = [
            offer({ id: 1, expiryDate: at(2) }), // inside 3 days
            offer({ id: 2, applicationId: 11, expiryDate: at(5) }), // outside the window
            offer({ id: 3, applicationId: 12, expiryDate: at(1), expiryReminderSentAt: at(-1) }), // already reminded
            offer({ id: 4, applicationId: 13, expiryDate: at(1), status: "DRAFT" }), // not sent
        ];
        const result = await runOfferExpiryJob({ now: NOW });
        expect(result).toMatchObject({ tenants: 1, reminded: 1, expired: 0, failed: 0 });
        expect(byId(1).expiryReminderSentAt).toEqual(NOW);
        expect(byId(2).expiryReminderSentAt).toBeNull();
        const [reminder] = events(OFFER_EXPIRY_REMINDER_EVENT);
        expect(reminder.payload.payload).toEqual({
            offerId: "1",
            applicationId: "10",
            candidateId: "20",
            expiryDate: at(2).toISOString(),
        });
        // Stamp and event under one tenant transaction.
        const stamp = OPS.find((o) => o.op === "updateMany");
        expect(stamp).toMatchObject({ tenant: T1, tx: true });

        const again = await runOfferExpiryJob({ now: NOW });
        expect(again.reminded).toBe(0);
        expect(events(OFFER_EXPIRY_REMINDER_EVENT)).toHaveLength(1);
    });

    it("follows the tenant's offerReminderDays; zero turns reminders off", async () => {
        OFFERS = [offer({ id: 1, expiryDate: at(5) })];
        getRecruitmentSettings.mockImplementation(async () => ({ offerReminderDays: 7 }));
        expect((await runOfferExpiryJob({ now: NOW })).reminded).toBe(1);

        OFFERS = [offer({ id: 2, expiryDate: at(1) })];
        getRecruitmentSettings.mockImplementation(async () => ({ offerReminderDays: 0 }));
        expect((await runOfferExpiryJob({ now: NOW })).reminded).toBe(0);
        expect(byId(2).expiryReminderSentAt).toBeNull();
    });

    it("does not stamp a reminder for an expiry date that changed after the read", async () => {
        OFFERS = [offer({ id: 1, expiryDate: at(2) })];
        const original = prisma.offer.updateMany.getMockImplementation();
        prisma.offer.updateMany.mockImplementationOnce((args) => {
            byId(1).expiryDate = at(20); // an extension lands between read and claim
            return original(args);
        });
        const result = await runOfferExpiryJob({ now: NOW });
        expect(result).toMatchObject({ reminded: 0, skipped: 1 });
        expect(byId(1).expiryReminderSentAt).toBeNull();
    });
});

describe("runOfferExpiryJob — expiry", () => {
    it("expires a past-due SENT offer, names the recruiter, and never rejects the application", async () => {
        OFFERS = [offer({ id: 1, expiryDate: at(-0.5) })];
        const result = await runOfferExpiryJob({ now: NOW });
        expect(result).toMatchObject({ expired: 1, reminded: 0 });
        expect(byId(1)).toMatchObject({ status: "EXPIRED", expiredAt: NOW, version: 4 });
        const [expired] = events(OFFER_EXPIRED_EVENT);
        expect(expired.payload.payload).toMatchObject({
            offerId: "1",
            applicationId: "10",
            status: "EXPIRED",
            previousStatus: "SENT",
            createdById: "7",
            recruiterId: "8",
            version: 4,
        });
        expect(JSON.stringify(expired.payload)).not.toContain("100000");
        // A past-due offer is expired, not reminded.
        expect(events(OFFER_EXPIRY_REMINDER_EVENT)).toHaveLength(0);
        expect(prisma.application.update).not.toHaveBeenCalled();
        expect(prisma.application.updateMany).not.toHaveBeenCalled();
    });

    it("is idempotent: a second run changes nothing and emits nothing", async () => {
        OFFERS = [offer({ id: 1, expiryDate: at(-1) })];
        await runOfferExpiryJob({ now: NOW });
        const second = await runOfferExpiryJob({ now: NOW });
        expect(second.expired).toBe(0);
        expect(events(OFFER_EXPIRED_EVENT)).toHaveLength(1);
        expect(byId(1).version).toBe(4);
    });

    it("loses gracefully to an answer that lands between read and claim", async () => {
        OFFERS = [offer({ id: 1, expiryDate: at(-1) })];
        const original = prisma.offer.updateMany.getMockImplementation();
        prisma.offer.updateMany.mockImplementationOnce((args) => {
            byId(1).status = "ACCEPTED";
            return original(args);
        });
        const result = await runOfferExpiryJob({ now: NOW });
        expect(result).toMatchObject({ expired: 0, skipped: 1 });
        expect(byId(1).status).toBe("ACCEPTED");
        expect(events(OFFER_EXPIRED_EVENT)).toHaveLength(0);
    });

    it("isolates a failing row and a failing tenant", async () => {
        OFFERS = [
            offer({ id: 1, expiryDate: at(-1) }),
            offer({ id: 2, applicationId: 11, expiryDate: at(-1) }),
            offer({ id: 3, tenantId: T2, applicationId: 12, expiryDate: at(-1) }),
        ];
        failEnqueueFor = 1;
        getRecruitmentSettings.mockImplementation(async ({ tenantId }) => {
            if (tenantId === T2) throw new Error("settings down");
            return { offerReminderDays: 3 };
        });
        const result = await runOfferExpiryJob({ now: NOW });
        expect(result.tenants).toBe(2);
        // Row 1's event failed, so its claim rolled back in the real database; the
        // fake has no rollback, so only the counters are asserted for it.
        expect(result.failed).toBe(1);
        expect(byId(2).status).toBe("EXPIRED");
        // Tenant 2's expiry ran before its settings read failed; the tenant is reported, not fatal.
        expect(byId(3).status).toBe("EXPIRED");
        expect(result.perTenant.find((p) => p.tenantId === T2).error).toBe("settings down");
    });

    it("discovers tenants under SYSTEM context and sweeps each under its own tenant", async () => {
        OFFERS = [offer({ id: 1, expiryDate: at(-1) }), offer({ id: 3, tenantId: T2, applicationId: 12, expiryDate: at(1) })];
        await runOfferExpiryJob({ now: NOW });
        expect(OPS[0]).toMatchObject({ model: "offer", op: "findMany", tenant: "SYSTEM" });
        expect(OPS.slice(1).every((o) => o.tenant === T1 || o.tenant === T2)).toBe(true);
        expect(byId(1).status).toBe("EXPIRED");
        expect(byId(3).expiryReminderSentAt).toEqual(NOW);
    });
});

describe("extendOfferExpiry", () => {
    const ORG = { unrestricted: true, level: "ORG", canSeeCompensation: true };
    const run = (args) =>
        mcpCtx.run({ user: { tenantId: T1, employeeId: 7 } }, async () =>
            await extendOfferExpiry({ tenantId: T1, id: 1, scope: ORG, actorId: 7, now: NOW, ...args }),
        );

    beforeEach(() => {
        APPROVALS = [{ id: "a0a0a0a0-0000-4000-8000-000000000001", tenantId: T1, kind: "OFFER", sourceRef: "1", stage: "APPROVED" }];
    });

    it("extends a SENT offer with no approved request: new date, count, reminder cleared, version, event", async () => {
        APPROVALS = [];
        OFFERS = [offer({ expiryDate: at(1), expiryReminderSentAt: at(-1) })];
        const result = await run({ expiryDate: at(14).toISOString() });
        expect(result).toMatchObject({ reopened: false, status: "SENT", expiryExtendedCount: 1, version: 4 });
        expect(byId(1)).toMatchObject({ expiryDate: at(14), expiryReminderSentAt: null });
        // Never written around the Approval Centre's freeze.
        expect(RAW.find((r) => r.sql.includes("app.hr_approval_finalizing"))).toBeUndefined();
        expect(RAW[0].sql).toContain('FROM "offers"');
        const [evt] = events(OFFER_EXPIRY_EXTENDED_EVENT);
        expect(evt.payload.payload).toMatchObject({
            offerId: "1",
            previousExpiryDate: at(1).toISOString(),
            expiryDate: at(14).toISOString(),
            expiryExtendedCount: 1,
            reopened: false,
        });
        expect(evt.payload.actor.id).toBe("7");
    });

    it("refuses an offer whose approval stands: a new expiry needs a new approval", async () => {
        OFFERS = [offer({ expiryDate: at(1) })];
        await expect(run({ expiryDate: at(14).toISOString() }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-EXTEND-NEEDS-APPROVAL" });
        expect(byId(1)).toMatchObject({ expiryDate: at(1), expiryExtendedCount: 0 });
        expect(RAW.find((r) => r.sql.includes("app.hr_approval_finalizing"))).toBeUndefined();
        expect(events(OFFER_EXPIRY_EXTENDED_EVENT)).toHaveLength(0);
    });

    it("refuses a past date, more than 60 days ahead, or not later than the current expiry", async () => {
        OFFERS = [offer({ expiryDate: at(10) })];
        for (const expiryDate of [at(-1).toISOString(), at(61).toISOString(), at(5).toISOString(), "not-a-date"]) {
            await expect(run({ expiryDate })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-OFFER-EXPIRY-INVALID" });
        }
        expect(byId(1).expiryExtendedCount).toBe(0);
    });

    it("is ORG only", async () => {
        OFFERS = [offer()];
        await expect(run({ expiryDate: at(14).toISOString(), scope: { unrestricted: false, level: "MANAGED" } }))
            .rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-OFFER-EXTEND-FORBIDDEN" });
        expect(prisma.offer.updateMany).not.toHaveBeenCalled();
    });

    it("refuses a finalized offer and a stale version", async () => {
        OFFERS = [offer({ status: "ACCEPTED" })];
        await expect(run({ expiryDate: at(14).toISOString() })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-STATUS" });
        OFFERS = [offer()];
        await expect(run({ expiryDate: at(14).toISOString(), expectedVersion: 1 })).rejects.toMatchObject({ status: 412, currentVersion: 3 });
    });

    it("never reopens an EXPIRED offer around its approval: it needs a new one", async () => {
        OFFERS = [offer({ status: "EXPIRED", expiryDate: at(-3), expiredAt: at(-3) })];
        await expect(run({ expiryDate: at(10).toISOString() }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-EXTEND-NEEDS-APPROVAL" });
        expect(byId(1).status).toBe("EXPIRED");
    });

    it("refuses to reopen after 7 days, on a closed requisition, a disposed application or without a standing approval", async () => {
        OFFERS = [offer({ status: "EXPIRED", expiryDate: at(-8), expiredAt: at(-8) })];
        await expect(run({ expiryDate: at(10).toISOString() })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-EXTEND-WINDOW-CLOSED" });

        OFFERS = [offer({ status: "EXPIRED", expiredAt: at(-1), jobRequisition: { recruiterId: 8, status: "CLOSED" } })];
        await expect(run({ expiryDate: at(10).toISOString() })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-REQUISITION-CLOSED" });

        OFFERS = [offer({ status: "EXPIRED", expiredAt: at(-1), application: { stage: "rejected" } })];
        await expect(run({ expiryDate: at(10).toISOString() })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-APPLICATION-DISPOSED" });

        OFFERS = [offer({ status: "EXPIRED", expiredAt: at(-1) })];
        APPROVALS = [];
        await expect(run({ expiryDate: at(10).toISOString() })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED" });
        expect(byId(1).status).toBe("EXPIRED");
    });

    it("applies the communications gate (do-not-contact refuses the extension)", async () => {
        OFFERS = [offer()];
        assertCommunicationsAllowed.mockRejectedValueOnce(Object.assign(new Error("dnc"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" }));
        await expect(run({ expiryDate: at(14).toISOString() })).rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-BLOCKED" });
        expect(byId(1).expiryExtendedCount).toBe(0);
    });

    it("works with the expiry flag off", async () => {
        delete process.env.HR_RECRUITMENT_OFFER_EXPIRY;
        APPROVALS = [];
        OFFERS = [offer()];
        await expect(run({ expiryDate: at(14).toISOString() })).resolves.toMatchObject({ expiryExtendedCount: 1 });
    });
});
