// tests/unit/services/offer-extension-approval.test.js
//
// Recruitment Phase 6 (stream C) — offer expiry extension re-approval through
// the HR Approval Centre (flag offerExtensionApproval).
//
// Pinned: with the flag on, extending a SENT offer whose approval stands
// submits a NEW OFFER request (reference "<id>@x<seq>.<attempt>.<ms>") as the
// offer's creator and leaves the offer unchanged; a repeat replays; one open
// extension per offer; an expired offer is still not reopened. The Centre's
// decision hands over to applyOfferExtensionDecision: APPROVE writes the
// proposed date under the finalizing marker, conditional on the revision it
// named (stale ones are refused, so nothing applies twice); REJECT changes
// nothing. A recruiter may withdraw an open request; the offer is untouched.
// Events are ids-only.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { matches } from "./helpers/resume-ledger.fake.js";
import { mcpCtx } from "../../../src/lib/requestContext.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days) => new Date(NOW.getTime() + days * DAY);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let OFFERS = [];
let OUTBOX = [];
let APPROVALS = [];
let AUDITS = [];
let EMPLOYEES = [];
let RAW = [];
let seq = 0;

const clone = (value) => {
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
    return value;
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
const inContext = () => {
    const store = mcpCtx.getStore();
    if (!store?.system && !store?.user?.tenantId) throw Object.assign(new Error("HR-4030: no tenant context"), { code: "HR-4030" });
};
const applyData = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && !(value instanceof Date) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
        else row[key] = value instanceof Date ? new Date(value) : value;
    }
};
const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, clone(row[k])])) : clone(row));

const prisma = {
    offer: {
        findFirst: jest.fn(({ where, select } = {}) => lazy(() => {
            inContext();
            const row = OFFERS.find((r) => matches(r, where));
            return row ? pick(row, select) : null;
        })),
        updateMany: jest.fn(({ where, data }) => lazy(() => {
            inContext();
            const hit = OFFERS.filter((r) => matches(r, where));
            hit.forEach((row) => applyData(row, data));
            return { count: hit.length };
        })),
    },
    jobRequisition: { findFirst: jest.fn(() => lazy(() => ({ recruiterId: 8 }))) },
    employee: {
        findFirst: jest.fn(({ where }) => lazy(() => {
            inContext();
            return clone(EMPLOYEES.find((e) => e.tenant_id === where.tenant_id && e.id === where.id) ?? null);
        })),
        findMany: jest.fn(({ where }) => lazy(() => {
            inContext();
            return EMPLOYEES.filter((e) => e.tenant_id === where.tenant_id && where.employee_code.in.includes(e.employee_code)).map(clone);
        })),
    },
    hrApprovalRequest: {
        findUnique: jest.fn(({ where }) => lazy(() => {
            inContext();
            const key = where.tenantId_kind_sourceRef;
            return clone(APPROVALS.find((a) => a.tenantId === key.tenantId && a.kind === key.kind && a.sourceRef === key.sourceRef) ?? null);
        })),
        findMany: jest.fn(({ where, select } = {}) => lazy(() => {
            inContext();
            return APPROVALS.filter((a) => matches(a, where)).sort((a, b) => a.createdAt - b.createdAt).map((a) => pick(a, select));
        })),
        findFirst: jest.fn(({ where }) => lazy(() => {
            inContext();
            return clone(APPROVALS.find((a) => matches(a, where)) ?? null);
        })),
        update: jest.fn(({ where, data }) => lazy(() => {
            const row = APPROVALS.find((a) => a.id === where.id);
            applyData(row, data);
            return clone(row);
        })),
    },
    hrApprovalAudit: {
        create: jest.fn(({ data }) => lazy(() => { AUDITS.push(clone(data)); return data; })),
        // Phase 7 (B10) — the decision trail the extension read shows.
        findMany: jest.fn(({ where }) => lazy(() => {
            inContext();
            return AUDITS.filter((a) => a.tenantId === where.tenantId && a.approvalRef === where.approvalRef).map(clone);
        })),
    },
    outboxEvent: { create: jest.fn(async ({ data }) => { OUTBOX.push(data); return data; }) },
    $queryRaw: jest.fn(async (strings, ...values) => { RAW.push({ sql: strings.join("?"), values }); return []; }),
    $executeRaw: jest.fn(async (strings, ...values) => { RAW.push({ sql: strings.join("?"), values }); return 1; }),
};

const tenantTransaction = jest.fn(async (client, fn) => fn(client));
const assertCommunicationsAllowed = jest.fn(async () => ({ allowed: true }));
const submitApproval = jest.fn(async (input) => {
    seq += 1;
    const row = { id: `00000000-0000-4000-8000-00000000000${seq}`, tenantId: T1, kind: input.kind, sourceRef: input.sourceRef, stage: "LINE_MANAGER", version: input.expectedVersion + 1, round: 1, execution: "PENDING", employeeCode: input.employeeCode, sourceHash: "h", createdAt: new Date(NOW.getTime() + seq) };
    const existing = APPROVALS.find((a) => a.sourceRef === input.sourceRef);
    if (existing) Object.assign(existing, { stage: "LINE_MANAGER", version: existing.version + 1 });
    else APPROVALS.push(row);
    const rec = existing ?? row;
    return { actorCode: input.employeeCode, record: { approvalRef: rec.id, kind: "OFFER", sourceRef: rec.sourceRef, stage: rec.stage, version: rec.version, execution: "PENDING" } };
});

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({ tenantTransaction, rlsTenantExtension: (c) => c }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings: async () => ({}) }));
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({ assertCommunicationsAllowed }));
jest.unstable_mockModule("../../../src/services/approval/service.js", () => ({ submitApproval }));

const svc = await import("../../../src/services/offer-expiry.service.js");
const util = await import("../../../src/lib/offer-extension.util.js");

const ORG = { unrestricted: true, level: "ORG", canSeeCompensation: true };
const ORIGINAL = { id: "a0a0a0a0-0000-4000-8000-000000000001", tenantId: T1, kind: "OFFER", sourceRef: "1", stage: "APPROVED", version: 4, round: 1, createdAt: at(-5) };
const offer = (over = {}) => ({
    id: 1, tenantId: T1, applicationId: 10, candidateId: 20, jobRequisitionId: 30, status: "SENT",
    expiryDate: at(2), expiryReminderSentAt: at(-1), expiredAt: null, expiryExtendedCount: 0, createdById: 7, version: 3,
    jobRequisition: { status: "POSTED" }, application: { stage: "offer" }, ...over,
});
const extRequest = (over = {}) => ({
    id: `e0e0e0e0-0000-4000-8000-00000000000${APPROVALS.length}`, tenantId: T1, kind: "OFFER",
    sourceRef: util.buildOfferExtensionRef({ offerId: 1, sequence: 1, attempt: 1, proposedExpiryDate: at(14) }),
    stage: "HR", version: 2, round: 1, execution: "PENDING", employeeCode: "E-7", sourceHash: "h", createdAt: at(-1), ...over,
});
const events = (name) => OUTBOX.filter((o) => o.eventName === name);
const byId = (id) => OFFERS.find((o) => o.id === id);
const as = (fn, user = { tenantId: T1, employeeId: 7 }) => mcpCtx.run({ user }, async () => await fn());
const extend = (args = {}) => as(() => svc.extendOfferExpiry({ tenantId: T1, id: 1, scope: ORG, actorId: 7, now: NOW, expiryDate: at(14).toISOString(), ...args }));

beforeEach(() => {
    jest.clearAllMocks();
    OFFERS = [offer()];
    OUTBOX = [];
    APPROVALS = [{ ...ORIGINAL }];
    AUDITS = [];
    EMPLOYEES = [{ id: 7, tenant_id: T1, employee_code: "E-7" }, { id: 9, tenant_id: T1, employee_code: "E-9" }];
    RAW = [];
    seq = 0;
    process.env.HR_RECRUITMENT_OFFER_EXTENSION_APPROVAL = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_OFFER_EXTENSION_APPROVAL;
});

describe("offer extension reference", () => {
    it("round-trips and binds the revision, the attempt and the proposed date", () => {
        const ref = util.buildOfferExtensionRef({ offerId: 12, sequence: 2, attempt: 3, proposedExpiryDate: at(9) });
        expect(ref).toBe(`12@x2.3.${at(9).getTime()}`);
        expect(util.parseOfferExtensionRef(ref)).toEqual({ offerId: 12, sequence: 2, attempt: 3, proposedExpiryDate: at(9) });
        expect(util.offerExtensionSnapshot(ref)).toEqual({ sequence: 2, attempt: 3, proposedExpiryDate: at(9).toISOString() });
        expect(ref.startsWith(util.offerExtensionRefPrefix(12))).toBe(true);
    });

    it("is never confused with the original OFFER reference or another kind's suffix", () => {
        for (const ref of ["12", "12@3", "12@x", "12@x1.1", "0@x1.1.1792000000000", "12@x1.1.12", "12@x1.1.1792000000000 "]) {
            expect(util.isOfferExtensionRef(ref)).toBe(false);
        }
        expect(util.offerExtensionSnapshot("12")).toBeNull();
    });
});

describe("extendOfferExpiry with offerExtensionApproval on", () => {
    it("submits a new OFFER request as the offer's creator and leaves the offer as it is", async () => {
        const out = await extend({ reason: "Candidate asked for a week" });
        expect(submitApproval).toHaveBeenCalledTimes(1);
        const input = submitApproval.mock.calls[0][0];
        expect(input).toMatchObject({
            kind: "OFFER",
            sourceRef: `1@x1.1.${at(14).getTime()}`,
            employeeCode: "E-7",
            expectedVersion: 0,
            reason: "Candidate asked for a week",
        });
        expect(input.requestKey).toMatch(UUID);
        // Unchanged until the Centre decides: same date, count, reminder stamp and version.
        expect(byId(1)).toMatchObject({ expiryDate: at(2), expiryExtendedCount: 0, expiryReminderSentAt: at(-1), version: 3 });
        expect(prisma.offer.updateMany).not.toHaveBeenCalled();
        expect(RAW.find((r) => r.sql.includes("app.hr_approval_finalizing"))).toBeUndefined();
        expect(out).toMatchObject({
            id: 1,
            pendingApproval: true,
            replayed: false,
            reopened: false,
            extensionApproval: { stage: "LINE_MANAGER", sequence: 1, attempt: 1, proposedExpiryDate: at(14).toISOString(), currentExpiryDate: at(2).toISOString() },
        });
        expect(out.jobRequisition).toBeUndefined();
        expect(OUTBOX).toHaveLength(0);
    });

    it("replays an open request for the same date without submitting again", async () => {
        APPROVALS.push(extRequest());
        const out = await extend();
        expect(submitApproval).not.toHaveBeenCalled();
        expect(out).toMatchObject({ pendingApproval: true, replayed: true, extensionApproval: { stage: "HR", attempt: 1 } });
    });

    it("refuses a second date while one extension is open", async () => {
        APPROVALS.push(extRequest());
        await expect(extend({ expiryDate: at(20).toISOString() })).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-EXTENSION-PENDING" });
        expect(submitApproval).not.toHaveBeenCalled();
    });

    it("resubmits a request returned to the initiator at its version, and numbers a new attempt after a rejection", async () => {
        APPROVALS.push(extRequest({ stage: "INITIATOR", version: 5 }));
        await extend();
        expect(submitApproval.mock.calls[0][0]).toMatchObject({ sourceRef: `1@x1.1.${at(14).getTime()}`, expectedVersion: 5 });
        const firstKey = submitApproval.mock.calls[0][0].requestKey;

        APPROVALS = [{ ...ORIGINAL }, extRequest({ stage: "REJECTED" })];
        submitApproval.mockClear();
        await extend();
        expect(submitApproval.mock.calls[0][0]).toMatchObject({ sourceRef: `1@x1.2.${at(14).getTime()}`, expectedVersion: 0 });
        expect(submitApproval.mock.calls[0][0].requestKey).not.toBe(firstKey);
    });

    it("lets only the offer's creator submit, and needs an employee initiator", async () => {
        await expect(extend({ actorId: 9 })).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-OFFER-EXTENSION-INITIATOR-ONLY" });
        OFFERS = [offer({ createdById: null })];
        await expect(extend()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-EXTENSION-NO-INITIATOR" });
        expect(submitApproval).not.toHaveBeenCalled();
    });

    it("still never reopens an EXPIRED offer", async () => {
        OFFERS = [offer({ status: "EXPIRED", expiredAt: at(-1), expiryDate: at(-1) })];
        await expect(extend()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED" });
        expect(byId(1).status).toBe("EXPIRED");
        expect(submitApproval).not.toHaveBeenCalled();
    });

    it("keeps the direct extension for an offer with no approved request", async () => {
        APPROVALS = [];
        const out = await extend();
        expect(out).toMatchObject({ expiryExtendedCount: 1, reopened: false });
        expect(out.pendingApproval).toBeUndefined();
        expect(submitApproval).not.toHaveBeenCalled();
    });

    it("refuses an over-long reason before any write", async () => {
        await expect(extend({ reason: "x".repeat(1001) })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-OFFER-EXTENSION-REASON-INVALID" });
        expect(tenantTransaction).not.toHaveBeenCalled();
    });

    it("is unchanged with the flag off: the standing approval refuses", async () => {
        delete process.env.HR_RECRUITMENT_OFFER_EXTENSION_APPROVAL;
        await expect(extend()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-EXTEND-NEEDS-APPROVAL" });
        expect(submitApproval).not.toHaveBeenCalled();
    });
});

describe("applyOfferExtensionDecision (the Approval Centre's final decision)", () => {
    const env = { tenantId: T1, now: NOW, who: { id: 55, employee_code: "M-55" } };
    const ref = (over = {}) => util.buildOfferExtensionRef({ offerId: 1, sequence: 1, attempt: 1, proposedExpiryDate: at(14), ...over });
    const decide = (approved, { request = { id: "r-1", kind: "OFFER", sourceRef: ref() }, row = byId(1) } = {}) =>
        as(() => svc.applyOfferExtensionDecision(prisma, env, request, { row: clone(row) }, approved), { tenantId: T1 });

    it("APPROVE applies the proposed date under the finalizing marker, once", async () => {
        expect(await decide(true)).toBe("APPLIED");
        expect(byId(1)).toMatchObject({ expiryDate: at(14), expiryExtendedCount: 1, expiryReminderSentAt: null, version: 4, status: "SENT" });
        const marker = RAW.find((r) => r.sql.includes("app.hr_approval_finalizing"));
        expect(marker.values).toEqual(["OFFER:1"]);
        expect(prisma.offer.updateMany.mock.calls[0][0].where).toMatchObject({ id: 1, status: "SENT", expiryExtendedCount: 0, tenantId: T1 });

        const [extended] = events(svc.OFFER_EXPIRY_EXTENDED_EVENT);
        expect(extended.payload.payload).toMatchObject({ offerId: "1", previousExpiryDate: at(2).toISOString(), expiryDate: at(14).toISOString(), expiryExtendedCount: 1, reopened: false });
        const [decided] = events(svc.OFFER_EXPIRY_EXTENSION_DECIDED_EVENT);
        expect(decided.payload.payload).toEqual({
            offerId: "1", applicationId: "10", candidateId: "20", jobRequisitionId: "30", approvalRef: "r-1", decision: "APPROVED",
            proposedExpiryDate: at(14).toISOString(), expiryDate: at(14).toISOString(), version: 4, createdById: "7", recruiterId: "8",
        });
        expect(decided.payload.actor.id).toBe("55");

        // The same revision again is stale: never applied twice.
        await expect(decide(true)).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-OFFER-EXTENSION-STALE" });
        expect(byId(1).expiryExtendedCount).toBe(1);
    });

    it("REJECT leaves the offer unchanged", async () => {
        expect(await decide(false)).toBe("APPLIED");
        expect(byId(1)).toMatchObject({ expiryDate: at(2), expiryExtendedCount: 0, version: 3 });
        expect(prisma.offer.updateMany).not.toHaveBeenCalled();
        expect(events(svc.OFFER_EXPIRY_EXTENSION_DECIDED_EVENT)[0].payload.payload).toMatchObject({ decision: "REJECTED", expiryDate: at(2).toISOString() });
        expect(events(svc.OFFER_EXPIRY_EXTENDED_EVENT)).toHaveLength(0);
    });

    it("refuses a stale approval: an expired offer, a passed date or another revision", async () => {
        OFFERS = [offer({ status: "EXPIRED", expiredAt: at(-1) })];
        await expect(decide(true)).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-EXTENSION-STALE" });
        OFFERS = [offer()];
        await expect(decide(true, { request: { id: "r", sourceRef: ref({ proposedExpiryDate: at(-1) }) } })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-EXTENSION-STALE" });
        await expect(decide(true, { request: { id: "r", sourceRef: ref({ sequence: 2 }) } })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-EXTENSION-STALE" });
        await expect(decide(true, { request: { id: "r", sourceRef: ref({ proposedExpiryDate: at(1) }) } })).rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-EXTENSION-STALE" });
        expect(byId(1)).toMatchObject({ status: "SENT", expiryDate: at(2), expiryExtendedCount: 0 });
        expect(OUTBOX).toHaveLength(0);
    });

    it("re-applies the contact gate and refuses a request for another offer", async () => {
        assertCommunicationsAllowed.mockRejectedValueOnce(Object.assign(new Error("dnc"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" }));
        await expect(decide(true)).rejects.toMatchObject({ code: "HR-RECRUITMENT-DNC-BLOCKED" });
        await expect(decide(true, { request: { id: "r", sourceRef: util.buildOfferExtensionRef({ offerId: 2, sequence: 1, attempt: 1, proposedExpiryDate: at(14) }) } }))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-OFFER-EXTENSION-INVALID" });
        expect(byId(1).expiryExtendedCount).toBe(0);
    });
});

describe("withdraw and read", () => {
    const withdraw = (args = {}) => as(() => svc.withdrawOfferExtension({ tenantId: T1, id: 1, scope: ORG, actorId: 7, ...args }));

    it("withdraws the open request with an audit row and the Centre's announcement; the offer is untouched", async () => {
        APPROVALS.push(extRequest({ stage: "MANAGEMENT", version: 3 }));
        const out = await withdraw({ reason: "Candidate accepted already" });
        expect(out.withdrawn).toHaveLength(1);
        expect(out.withdrawn[0]).toMatchObject({ stage: "WITHDRAWN", execution: "APPLIED", proposedExpiryDate: at(14).toISOString() });
        expect(APPROVALS[1]).toMatchObject({ stage: "WITHDRAWN", execution: "APPLIED", version: 4 });
        expect(APPROVALS[0].stage).toBe("APPROVED");
        expect(AUDITS).toEqual([expect.objectContaining({ approvalRef: APPROVALS[1].id, version: 4, actorCode: "E-7", fromStage: "MANAGEMENT", toStage: "WITHDRAWN", action: "WITHDRAW", reason: "Candidate accepted already" })]);
        expect(events("hr.approval.transitioned.v1")[0].payload.payload).toMatchObject({ toStage: "WITHDRAWN", action: "WITHDRAW", kind: "OFFER" });
        expect(events(svc.OFFER_EXPIRY_EXTENSION_DECIDED_EVENT)[0].payload.payload).toMatchObject({ decision: "WITHDRAWN", expiryDate: at(2).toISOString() });
        expect(prisma.offer.updateMany).not.toHaveBeenCalled();
        expect(byId(1)).toMatchObject({ expiryDate: at(2), version: 3 });

        // A repeat replays.
        const again = await withdraw();
        expect(again).toMatchObject({ withdrawn: [], latest: { stage: "WITHDRAWN" } });
        expect(AUDITS).toHaveLength(1);
    });

    it("answers 404 with nothing to withdraw, 503 with the flag off and 403 outside ORG", async () => {
        await expect(withdraw()).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-OFFER-EXTENSION-NOT-FOUND" });
        await expect(withdraw({ scope: { unrestricted: false, level: "MANAGED" } })).rejects.toMatchObject({ status: 403 });
        await expect(withdraw({ actorId: null })).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-OFFER-EXTENSION-ACTOR-REQUIRED" });
        delete process.env.HR_RECRUITMENT_OFFER_EXTENSION_APPROVAL;
        await expect(withdraw()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-OFFER-EXTENSION-APPROVAL-DISABLED" });
    });

    it("reads the latest request and whether it is open", async () => {
        const none = await as(() => svc.getOfferExtensionApproval({ tenantId: T1, id: 1, scope: ORG }));
        expect(none).toMatchObject({ offerId: 1, status: "SENT", expiryExtendedCount: 0, open: false, latest: null });
        APPROVALS.push(extRequest({ stage: "REJECTED", createdAt: at(-2) }), extRequest({ stage: "LINE_MANAGER", sourceRef: util.buildOfferExtensionRef({ offerId: 1, sequence: 1, attempt: 2, proposedExpiryDate: at(20) }) }));
        const out = await as(() => svc.getOfferExtensionApproval({ tenantId: T1, id: 1, scope: ORG }));
        expect(out).toMatchObject({ open: true, latest: { stage: "LINE_MANAGER", attempt: 2, proposedExpiryDate: at(20).toISOString() } });
    });

    it("Phase 7 (B10): the latest request carries its decision trail with the deciders' names", async () => {
        EMPLOYEES.push({ id: 12, tenant_id: T1, employee_code: "E-12", first_name: "Hina", last_name: "Raza" });
        EMPLOYEES.push({ id: 13, tenant_id: "22222222-2222-4222-8222-222222222222", employee_code: "E-13", first_name: "Other", last_name: "Tenant" });
        APPROVALS.push(extRequest({ stage: "MANAGEMENT" }));
        const ref = APPROVALS.at(-1).id;
        AUDITS.push(
            { tenantId: T1, approvalRef: ref, version: 1, actorCode: "E-12", fromStage: "LINE_MANAGER", toStage: "HR", action: "APPROVE", reason: "ok", createdAt: at(-1) },
            { tenantId: T1, approvalRef: ref, version: 2, actorCode: "E-13", fromStage: "HR", toStage: "MANAGEMENT", action: "APPROVE", reason: "ok", createdAt: at(-1) },
            { tenantId: T1, approvalRef: ref, version: 3, actorCode: "SYSTEM", fromStage: "MANAGEMENT", toStage: "MANAGEMENT", action: "REMIND", reason: "x", createdAt: at(-1) },
        );
        const out = await as(() => svc.getOfferExtensionApproval({ tenantId: T1, id: 1, scope: ORG }));
        expect(out.latest.decisions).toEqual([
            { action: "APPROVE", fromStage: "LINE_MANAGER", toStage: "HR", decidedAt: at(-1).toISOString(), decidedByCode: "E-12", decidedByName: "Hina Raza" },
            { action: "APPROVE", fromStage: "HR", toStage: "MANAGEMENT", decidedAt: at(-1).toISOString(), decidedByCode: "E-13", decidedByName: null },
            { action: "REMIND", fromStage: "MANAGEMENT", toStage: "MANAGEMENT", decidedAt: at(-1).toISOString(), decidedByCode: "SYSTEM", decidedByName: null },
        ]);
        // Reasons are free text and stay in the Approval Centre.
        expect(JSON.stringify(out)).not.toContain('"reason"');
        expect(prisma.employee.findMany).toHaveBeenCalledTimes(1);
    });
});

describe("runOfferExtensionCloseJob (Phase 6 hardening)", () => {
    const run = () => mcpCtx.run({ system: true }, async () => await svc.runOfferExtensionCloseJob({ now: NOW }));

    it("withdraws an open extension request once its offer is accepted, as the system", async () => {
        APPROVALS.push(extRequest({ stage: "MANAGEMENT", version: 3 }));
        OFFERS = [offer({ status: "ACCEPTED" })];
        const out = await run();
        expect(out).toMatchObject({ scanned: 1, closed: 1, stillOpen: 0, failed: 0 });
        const ext = APPROVALS.find((a) => a.sourceRef.includes("@x"));
        expect(ext.stage).toBe("WITHDRAWN");
        expect(AUDITS.at(-1)).toMatchObject({ actorCode: "SYSTEM", fromStage: "MANAGEMENT", toStage: "WITHDRAWN", action: "WITHDRAW" });
        expect(AUDITS.at(-1).reason).toMatch(/ACCEPTED/);
        expect(events("hr.approval.transitioned.v1").at(-1).payload.actor).toMatchObject({ type: "automation", id: "SYSTEM" });
        expect(events("hr.recruitment.offer_expiry_extension_decided.v1").at(-1).payload.payload).toMatchObject({ decision: "WITHDRAWN" });
        // The offer row is never touched.
        expect(byId(1).status).toBe("ACCEPTED");
    });

    it("withdraws it when the offer declined, or is SENT but already past its expiry", async () => {
        APPROVALS.push(extRequest());
        OFFERS = [offer({ status: "SENT", expiryDate: at(-1) })];
        expect(await run()).toMatchObject({ closed: 1 });
        APPROVALS = [{ ...ORIGINAL }, extRequest()];
        OFFERS = [offer({ status: "DECLINED" })];
        expect(await run()).toMatchObject({ closed: 1 });
    });

    it("leaves a request on a live SENT offer alone, and does nothing with the flag off", async () => {
        APPROVALS.push(extRequest());
        expect(await run()).toMatchObject({ scanned: 1, closed: 0, stillOpen: 1 });
        expect(APPROVALS.find((a) => a.sourceRef.includes("@x")).stage).toBe("HR");
        delete process.env.HR_RECRUITMENT_OFFER_EXTENSION_APPROVAL;
        OFFERS = [offer({ status: "ACCEPTED" })];
        expect(await run()).toEqual({ skipped: "FLAG_OFF" });
        expect(APPROVALS.find((a) => a.sourceRef.includes("@x")).stage).toBe("HR");
    });
});
