// Recruitment Phase 6 — referrals: the forfeit reason and note live on the row
// (manual decision and the clock's HIRE_SEPARATED) and come back on the HR
// list; a referral of a candidate an agency owns inside its window is
// recorded DUPLICATE (no application) with a coded reason for the recruiter.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

import { makeInternalMobilityDb } from "./helpers/internal-mobility.fake.js";

const fake = { current: null };
const dbProxy = new Proxy({}, { get: (_t, key) => fake.current.db[key] });
const logAction = jest.fn(async () => undefined);

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: dbProxy, prisma: dbProxy }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: dbProxy }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction }));

const svc = await import("../../../src/services/internal-referral.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitment-access.util.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const REFERRER = 101;
const MGR = 102;
const HR = 160;
const NOW = new Date("2026-10-20T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const asUser = (fn, { tenantId = T1, employeeId = HR } = {}) =>
    mcpCtx.run({ user: { tenantId, employeeId } }, async () => await fn());

let f;
let reqA;
beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_INTERNAL_BOARD = "true";
    f = makeInternalMobilityDb();
    fake.current = f;
    reqA = f.seed("jobRequisition", { tenantId: T1, title: "Backend Engineer", requestedById: MGR, recruiterId: 7 }).id;
    f.seed("employee", { id: REFERRER, tenant_id: T1, status: "Active" });
});
afterAll(() => {
    delete process.env.HR_RECRUITMENT_INTERNAL_BOARD;
});

const referral = (extra = {}) =>
    f.seed("internalReferral", { tenantId: T1, requisitionId: reqA, referrerEmployeeId: REFERRER, candidateId: 1, applicationId: 77, ...extra });
const decide = (args) => asUser(() => svc.updateReferralBonus({ tenantId: T1, actorId: HR, now: NOW, ...args }));
const list = (user) => asUser(() => svc.listReferrals({ tenantId: T1, scope: resolveRecruitmentScope(user) }));

describe("forfeit reason on the row", () => {
    it("writes the coded reason and note on a manual FORFEITED and returns them", async () => {
        const r = referral({ status: "HIRED", bonusStatus: "ELIGIBLE", version: 1 });
        const out = await decide({ referralId: r.id, expectedVersion: 1, bonusStatus: "FORFEITED", reason: "other", note: "  Left during probation " });
        expect(out).toMatchObject({ bonusStatus: "FORFEITED", bonusForfeitReason: "OTHER", bonusNote: "Left during probation" });
        expect(f.all("internalReferral")[0]).toMatchObject({ bonusForfeitReason: "OTHER", bonusNote: "Left during probation" });
    });

    it("stores no note when the reason needs none", async () => {
        const r = referral({ status: "HIRED", bonusStatus: "APPROVED" });
        await decide({ referralId: r.id, expectedVersion: 0, bonusStatus: "FORFEITED", reason: "DUPLICATE_CLAIM" });
        expect(f.all("internalReferral")[0]).toMatchObject({ bonusForfeitReason: "DUPLICATE_CLAIM", bonusNote: null });
    });

    it("keeps both columns empty on every other decision", async () => {
        const r = referral({ status: "HIRED", bonusStatus: "ELIGIBLE" });
        const approved = await decide({ referralId: r.id, expectedVersion: 0, bonusStatus: "APPROVED", amount: "100", currency: "PKR" });
        expect(approved).toMatchObject({ bonusForfeitReason: null, bonusNote: null });
        expect(f.all("internalReferral")[0]).toMatchObject({ bonusForfeitReason: null, bonusNote: null });
    });

    it("FORFEITED stays final: no decision moves away from it", async () => {
        const r = referral({ status: "HIRED", bonusStatus: "FORFEITED", bonusForfeitReason: "OTHER", bonusNote: "x" });
        await expect(decide({ referralId: r.id, expectedVersion: 0, bonusStatus: "APPROVED", amount: "1", currency: "PKR" }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-REFERRAL-BONUS-TRANSITION" });
        expect(f.all("internalReferral")[0]).toMatchObject({ bonusForfeitReason: "OTHER", bonusNote: "x" });
    });

    it("records HIRE_SEPARATED from the bonus clock", async () => {
        f.seed("employee", { id: 151, tenant_id: T1, status: "Active", separatedAt: new Date(NOW.getTime() - 5 * DAY) });
        referral({ applicationId: 78, status: "HIRED", bonusStatus: "PENDING", bonusEligibleAt: new Date(NOW.getTime() - DAY) });
        const offer = f.seed("offer", { tenantId: T1, applicationId: 78 });
        f.seed("offerHandoff", { tenantId: T1, offerId: offer.id, employeeId: 151 });
        expect(await svc.runReferralBonusJob({ now: NOW })).toMatchObject({ forfeited: 1 });
        expect(f.all("internalReferral")[0]).toMatchObject({ bonusStatus: "FORFEITED", bonusForfeitReason: "HIRE_SEPARATED", bonusNote: null });
    });

    it("shows the reason on the HR list, and the note only to a compensation scope", async () => {
        referral({ status: "HIRED", bonusStatus: "FORFEITED", bonusForfeitReason: "POLICY_INELIGIBLE", bonusNote: "In the hiring chain" });
        const hr = await list({ roles: ["RECRUITER"], employeeId: HR });
        expect(hr.items[0]).toMatchObject({ bonusForfeitReason: "POLICY_INELIGIBLE", bonusNote: "In the hiring chain" });
        const managed = await list({ roles: ["HIRING_MANAGER"], employeeId: MGR });
        expect(managed.items[0]).toMatchObject({ bonusForfeitReason: "POLICY_INELIGIBLE", bonusNote: null, compensationRedacted: true });
    });
});

describe("the agency rule at referral intake", () => {
    const base = () => ({ tenantId: T1, requisitionId: reqA, referrerEmployeeId: REFERRER, relationship: "friend", note: "great" });
    const record = (candidateId, { tenantId = T1, now = NOW } = {}) =>
        asUser(
            () => f.db.$transaction(async (tx) =>
                await svc.recordAgencyOwnedReferralInTx(tx, {
                    tenantId,
                    candidateId,
                    base: base(),
                    ctx: { actorId: REFERRER },
                    routing: { recruiterId: 7, requestedById: MGR },
                    now,
                })),
            { tenantId },
        );

    it("reads a live claim only (pure)", () => {
        expect(svc.liveAgencyOwnership({ ownerAgencyId: 4, ownershipExpiresAt: new Date(NOW.getTime() + DAY) }, NOW)).toMatchObject({ agencyId: 4 });
        expect(svc.liveAgencyOwnership({ ownerAgencyId: 4, ownershipExpiresAt: new Date(NOW.getTime() - 1) }, NOW)).toBeNull();
        expect(svc.liveAgencyOwnership({ ownerAgencyId: 4, ownershipExpiresAt: null }, NOW)).toBeNull();
        expect(svc.liveAgencyOwnership({ ownerAgencyId: null, ownershipExpiresAt: new Date(NOW.getTime() + DAY) }, NOW)).toBeNull();
        expect(svc.liveAgencyOwnership(null, NOW)).toBeNull();
    });

    it("records a DUPLICATE with no application for a candidate an agency owns inside its window", async () => {
        const c = f.seed("candidate", { tenantId: T1, email: "ann@example.com", ownerAgencyId: 4, ownershipExpiresAt: new Date(NOW.getTime() + 10 * DAY) });
        const row = await record(c.id);
        expect(row).toMatchObject({ status: "DUPLICATE", candidateId: c.id, requisitionId: reqA, referrerEmployeeId: REFERRER });
        expect(row.applicationId ?? null).toBeNull();
        expect(f.all("application")).toHaveLength(0);
        const [event] = f.events();
        expect(event).toMatchObject({
            name: "hr.recruitment.referral_submitted.v1",
            payload: { status: "DUPLICATE", duplicateReason: "AGENCY_OWNERSHIP", recruiterId: "7", candidateId: String(c.id) },
        });
        expect(JSON.stringify(event.payload)).not.toMatch(/ann|example/);
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T1, notes: expect.stringContaining("owned by agency 4") }));
    });

    it("lets the caller go on when the window has passed or nobody owns the candidate", async () => {
        const expired = f.seed("candidate", { tenantId: T1, email: "b@example.com", ownerAgencyId: 4, ownershipExpiresAt: new Date(NOW.getTime() - DAY) });
        const free = f.seed("candidate", { tenantId: T1, email: "c@example.com" });
        expect(await record(expired.id)).toBeNull();
        expect(await record(free.id)).toBeNull();
        expect(await record(null)).toBeNull();
        expect(f.all("internalReferral")).toHaveLength(0);
        expect(f.events()).toHaveLength(0);
    });

    it("never reads another tenant's candidate", async () => {
        const foreign = f.seed("candidate", { tenantId: T2, email: "d@example.com", ownerAgencyId: 4, ownershipExpiresAt: new Date(NOW.getTime() + DAY) });
        expect(await record(foreign.id)).toBeNull();
        expect(f.state.ops.filter((op) => op.model === "candidate").every((op) => op.tenant === T1)).toBe(true);
    });
});

describe("the referrer's own view masks a suppressed referral", () => {
    const made = new Date("2026-10-01T08:00:00Z");
    const fresh = { id: 1, requisitionId: 10, relationship: "friend", status: "SUBMITTED", bonusStatus: "NOT_ELIGIBLE", candidateId: 55, applicationId: 77, createdAt: made };
    // What intake stores for a do-not-contact / archived / consent-withdrawn contact.
    const suppressed = { id: 2, requisitionId: 10, relationship: "friend", status: "REJECTED", bonusStatus: "NOT_ELIGIBLE", candidateId: null, applicationId: null, createdAt: made };
    const strip = ({ id, ...rest }) => rest;

    it("cannot be told from a fresh referral while it is young", () => {
        for (const at of [made, new Date(made.getTime() + DAY), new Date(made.getTime() + 20 * DAY)]) {
            const a = svc.selfReferralView(fresh, { jobTitle: "Backend Engineer", now: at });
            const b = svc.selfReferralView(suppressed, { jobTitle: "Backend Engineer", now: at });
            expect(strip(b)).toEqual(strip(a));
            expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
            expect(b.status).toBe("SUBMITTED");
        }
    });

    it("reads as an ordinary unsuccessful referral after the fixed delay", () => {
        const later = new Date(made.getTime() + svc.SUPPRESSED_REFERRAL_CLOSE_DAYS * DAY);
        const closed = svc.selfReferralView(suppressed, { now: later });
        const ordinary = svc.selfReferralView({ ...fresh, status: "REJECTED" }, { now: later });
        expect(closed.status).toBe("REJECTED");
        expect(strip(closed)).toEqual(strip(ordinary));
    });

    it("leaves every other referral's status as it is", () => {
        expect(svc.isSuppressedReferral(suppressed)).toBe(true);
        for (const row of [fresh, { ...fresh, status: "REJECTED" }, { ...fresh, status: "DUPLICATE", applicationId: null }, { ...fresh, status: "HIRED", bonusStatus: "PENDING" }]) {
            expect(svc.isSuppressedReferral(row)).toBe(false);
            expect(svc.selfReferralView(row, { now: made })).toMatchObject({ status: row.status, bonusStatus: row.bonusStatus });
        }
    });
});
