// Recruitment Phase 5 (plan 6.2) — referrals on the HR side: the status sync
// the application workflow calls, the bonus decisions, the scoped list and
// the daily bonus clock, against an in-memory Prisma that enforces the tenant
// context at await time.
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
const { RECRUITMENT_SETTINGS_DEFAULTS } = await import("../../../src/services/recruitment-settings.service.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const REFERRER = 101;
const MGR = 102;
const HIRE = 150;
const HR = 160;
const NOW = new Date("2026-10-20T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const asUser = (fn, { tenantId = T1, employeeId = HR } = {}) =>
    mcpCtx.run({ user: { tenantId, employeeId } }, async () => await fn());

const failure = async (promise) => {
    try {
        await promise;
    } catch (err) {
        return { status: err.status, code: err.code, details: err.details };
    }
    throw new Error("expected a failure");
};

let f;
let reqA;
let reqB;
beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_INTERNAL_BOARD = "true";
    f = makeInternalMobilityDb();
    fake.current = f;
    reqA = f.seed("jobRequisition", { tenantId: T1, title: "Backend Engineer", requestedById: MGR }).id;
    reqB = f.seed("jobRequisition", { tenantId: T1, title: "Designer", requestedById: 999 }).id;
    f.seed("employee", { id: REFERRER, tenant_id: T1, status: "Active" });
    f.seed("employee", { id: HIRE, tenant_id: T1, status: "Active" });
});
afterAll(() => {
    delete process.env.HR_RECRUITMENT_INTERNAL_BOARD;
});

const referral = (extra = {}) => f.seed("internalReferral", { tenantId: T1, requisitionId: reqA, referrerEmployeeId: REFERRER, candidateId: 1, applicationId: 77, ...extra });
const sync = (stage, { applicationId = 77, tenantId = T1 } = {}) =>
    asUser(() => f.db.$transaction(async (tx) => await svc.syncReferralFromApplicationInTx(tx, { tenantId, applicationId, stage, now: NOW })), { tenantId });

describe("status sync", () => {
    it("follows the application through the pipeline", async () => {
        const r = referral();
        expect(await sync("applied")).toEqual({ updated: 0 });
        expect(await sync("screening")).toEqual({ updated: 1, status: "IN_PROCESS" });
        expect(f.all("internalReferral")[0]).toMatchObject({ id: r.id, status: "IN_PROCESS", version: 1 });
        expect(await sync("on_hold")).toEqual({ updated: 0, status: "IN_PROCESS" });
        await sync("rejected");
        expect(f.all("internalReferral")[0].status).toBe("REJECTED");
        // Terminal: a later sync never reopens it.
        expect(await sync("screening")).toEqual({ updated: 0 });
    });

    it("on hire stamps hiredAt from the offer start date and starts the bonus clock", async () => {
        referral({ status: "IN_PROCESS" });
        f.seed("offer", { tenantId: T1, applicationId: 77, startDate: new Date("2026-11-01T00:00:00Z") });
        f.seed("tenantRecruitmentSettings", { tenantId: T1, referralBonusWaitDays: 30 });
        await sync("hired");
        expect(f.all("internalReferral")[0]).toMatchObject({
            status: "HIRED",
            hiredAt: new Date("2026-11-01T00:00:00Z"),
            bonusStatus: "PENDING",
            bonusEligibleAt: new Date("2026-12-01T00:00:00Z"),
        });
    });

    it("falls back to now and the default wait, and leaves DUPLICATE and other tenants alone", async () => {
        expect(svc.DEFAULT_REFERRAL_BONUS_WAIT_DAYS).toBe(RECRUITMENT_SETTINGS_DEFAULTS.referralBonusWaitDays);
        referral();
        const dup = referral({ status: "DUPLICATE", applicationId: 77 });
        const other = f.seed("internalReferral", { tenantId: T2, requisitionId: 5, referrerEmployeeId: 9, applicationId: 77 });
        await sync("hired");
        const [mine] = f.all("internalReferral");
        expect(mine).toMatchObject({ status: "HIRED", hiredAt: NOW, bonusStatus: "PENDING" });
        expect(mine.bonusEligibleAt.getTime()).toBe(NOW.getTime() + 90 * DAY);
        expect(f.all("internalReferral").find((r) => r.id === dup.id).status).toBe("DUPLICATE");
        expect(f.all("internalReferral").find((r) => r.id === other.id).status).toBe("SUBMITTED");
    });

    it("is a no-op on a client without the referral model and for bad input", async () => {
        expect(await svc.syncReferralFromApplicationInTx({}, { tenantId: T1, applicationId: 77, stage: "hired" })).toEqual({ updated: 0 });
        expect(await svc.syncReferralFromApplicationInTx(f.db, { tenantId: T1, applicationId: "x", stage: "hired" })).toEqual({ updated: 0 });
    });
});

describe("bonus decisions", () => {
    const decide = (args) => asUser(() => svc.updateReferralBonus({ tenantId: T1, actorId: HR, now: NOW, ...args }));

    it("approves an ELIGIBLE bonus with amount and currency, then pays it", async () => {
        const r = referral({ status: "HIRED", bonusStatus: "ELIGIBLE", version: 3 });
        const approved = await decide({ referralId: r.id, expectedVersion: 3, bonusStatus: "APPROVED", amount: "25000.50", currency: "pkr" });
        expect(approved).toMatchObject({ bonusStatus: "APPROVED", bonusAmount: "25000.50", bonusCurrency: "PKR", bonusDecidedById: HR, version: 4, jobTitle: "Backend Engineer" });
        const paid = await decide({ referralId: r.id, expectedVersion: 4, bonusStatus: "PAID" });
        expect(paid).toMatchObject({ bonusStatus: "PAID", version: 5 });
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ module: "InternalReferral", notes: expect.stringContaining("ELIGIBLE -> APPROVED") }));
    });

    it("forfeits with a coded reason, and OTHER needs a note", async () => {
        const r = referral({ status: "HIRED", bonusStatus: "APPROVED", version: 0 });
        expect(await failure(decide({ referralId: r.id, expectedVersion: 0, bonusStatus: "FORFEITED" }))).toMatchObject({ status: 400, code: "HR-RECRUITMENT-REFERRAL-FORFEIT-REASON-INVALID" });
        expect(await failure(decide({ referralId: r.id, expectedVersion: 0, bonusStatus: "FORFEITED", reason: "OTHER" }))).toMatchObject({ status: 400 });
        const out = await decide({ referralId: r.id, expectedVersion: 0, bonusStatus: "FORFEITED", reason: "OTHER", note: "Left during probation" });
        expect(out.bonusStatus).toBe("FORFEITED");
        expect(logAction).toHaveBeenLastCalledWith(expect.objectContaining({ notes: expect.stringContaining("reason OTHER: Left during probation") }));
    });

    it("refuses what the rules do not allow, a stale version and a foreign id", async () => {
        const pending = referral({ status: "HIRED", bonusStatus: "PENDING" });
        expect(await failure(decide({ referralId: pending.id, expectedVersion: 0, bonusStatus: "APPROVED", amount: "1", currency: "PKR" }))).toMatchObject({
            status: 409,
            code: "HR-RECRUITMENT-REFERRAL-BONUS-TRANSITION",
            details: { from: "PENDING", to: "APPROVED", allowedFrom: ["ELIGIBLE"] },
        });
        const eligible = referral({ status: "HIRED", bonusStatus: "ELIGIBLE", version: 2 });
        expect(await failure(decide({ referralId: eligible.id, expectedVersion: 2, bonusStatus: "PAID" }))).toMatchObject({ status: 409, code: "HR-RECRUITMENT-REFERRAL-BONUS-TRANSITION" });
        expect(await failure(decide({ referralId: eligible.id, expectedVersion: 1, bonusStatus: "FORFEITED", reason: "DUPLICATE_CLAIM" }))).toMatchObject({
            status: 409,
            code: "HR-RECRUITMENT-REFERRAL-VERSION-CONFLICT",
            details: { currentVersion: 2 },
        });
        expect(await failure(decide({ referralId: eligible.id, expectedVersion: 2, bonusStatus: "APPROVED", amount: "-5", currency: "PKR" }))).toMatchObject({ status: 400, code: "HR-RECRUITMENT-REFERRAL-BONUS-AMOUNT-INVALID" });
        expect(await failure(decide({ referralId: eligible.id, expectedVersion: 2, bonusStatus: "APPROVED", amount: "5", currency: "RUPEES" }))).toMatchObject({ status: 400, code: "HR-RECRUITMENT-REFERRAL-BONUS-CURRENCY-INVALID" });
        expect(await failure(decide({ referralId: eligible.id, bonusStatus: "PAID" }))).toMatchObject({ status: 400, code: "HR-RECRUITMENT-REFERRAL-VERSION-REQUIRED" });
        const foreign = f.seed("internalReferral", { tenantId: T2, requisitionId: 5, referrerEmployeeId: 9, bonusStatus: "ELIGIBLE" });
        expect(await failure(decide({ referralId: foreign.id, expectedVersion: 0, bonusStatus: "FORFEITED", reason: "DUPLICATE_CLAIM" }))).toMatchObject({ status: 404 });
        expect(f.all("internalReferral").find((r) => r.id === eligible.id)).toMatchObject({ bonusStatus: "ELIGIBLE", version: 2 });
    });
});

describe("the HR list", () => {
    beforeEach(() => {
        referral({ status: "HIRED", bonusStatus: "APPROVED", bonusAmount: "1000.00", bonusCurrency: "PKR" });
        referral({ requisitionId: reqB, referrerEmployeeId: 120, status: "SUBMITTED" });
        f.seed("internalReferral", { tenantId: T2, requisitionId: 5, referrerEmployeeId: 9 });
    });
    const list = (user, args = {}) => asUser(() => svc.listReferrals({ tenantId: T1, scope: resolveRecruitmentScope(user), ...args }));

    it("gives recruiters every referral with the bonus amount, filtered", async () => {
        const all = await list({ roles: ["RECRUITER"], employeeId: HR });
        expect(all.total).toBe(2);
        expect(all.items.find((r) => r.requisitionId === reqA)).toMatchObject({ bonusAmount: "1000.00", bonusCurrency: "PKR", jobTitle: "Backend Engineer" });
        expect((await list({ roles: ["RECRUITER"] }, { status: "SUBMITTED" })).items.map((r) => r.requisitionId)).toEqual([reqB]);
        expect((await list({ roles: ["RECRUITER"] }, { bonusStatus: "APPROVED" })).total).toBe(1);
        expect((await list({ roles: ["RECRUITER"] }, { referrerEmployeeId: 120 })).total).toBe(1);
        expect((await list({ roles: ["RECRUITER"] }, { requisitionId: reqA })).total).toBe(1);
        expect(await failure(list({ roles: ["RECRUITER"] }, { status: "LOST" }))).toMatchObject({ status: 400 });
    });

    it("gives a hiring manager only their requisitions, without amounts, and finance nothing", async () => {
        const managed = await list({ roles: ["HIRING_MANAGER"], employeeId: MGR });
        expect(managed.items.map((r) => r.requisitionId)).toEqual([reqA]);
        expect(managed.items[0]).toMatchObject({ bonusAmount: null, bonusCurrency: null, compensationRedacted: true });
        expect((await list({ roles: ["HIRING_MANAGER"], employeeId: MGR }, { requisitionId: reqB })).total).toBe(0);
        expect((await list({ roles: ["FINANCE"], employeeId: 7 })).items).toEqual([]);
    });
});

describe("the bonus clock", () => {
    const hired = (extra = {}) =>
        referral({ status: "HIRED", bonusStatus: "PENDING", hiredAt: new Date(NOW.getTime() - 100 * DAY), bonusEligibleAt: new Date(NOW.getTime() - DAY), ...extra });
    const handoffFor = (applicationId, employeeId, tenantId = T1) => {
        const offer = f.seed("offer", { tenantId, applicationId });
        f.seed("offerHandoff", { tenantId, offerId: offer.id, employeeId });
    };

    it("is off with the flag", async () => {
        process.env.HR_RECRUITMENT_INTERNAL_BOARD = "false";
        expect(await svc.runReferralBonusJob({ now: NOW })).toEqual({ skipped: "FLAG_OFF" });
    });

    it("makes a due bonus ELIGIBLE while the hire still works here and tells HR, once", async () => {
        const r = hired();
        handoffFor(77, HIRE);
        const summary = await svc.runReferralBonusJob({ now: NOW });
        expect(summary).toMatchObject({ scanned: 1, eligible: 1, errors: 0 });
        expect(f.all("internalReferral")[0]).toMatchObject({ bonusStatus: "ELIGIBLE", version: 1 });
        const [event] = f.events();
        expect(event).toMatchObject({
            name: "hr.recruitment.referral_bonus_eligible.v1",
            tenantId: T1,
            payload: { referralId: String(r.id), hiredEmployeeId: String(HIRE), referrerEmployeeId: String(REFERRER), referrerEmployed: true, notifyRole: "HR" },
        });
        expect(await svc.runReferralBonusJob({ now: NOW })).toMatchObject({ scanned: 0 });
        expect(f.events()).toHaveLength(1);
        // The scan ran under SYSTEM, the settle under the row's tenant.
        expect(f.state.ops.find((op) => op.model === "internalReferral" && op.op === "findMany").tenant).toBe("SYSTEM");
        expect(f.state.ops.filter((op) => op.op === "updateMany").every((op) => op.tenant === T1 && op.tx != null)).toBe(true);
    });

    it("forfeits when the hire has left, waits for the handoff, and ignores bonuses not yet due", async () => {
        f.seed("employee", { id: 151, tenant_id: T1, status: "Active", separatedAt: new Date(NOW.getTime() - 5 * DAY) });
        hired({ applicationId: 78 });
        handoffFor(78, 151);
        hired({ applicationId: 79 }); // no handoff yet
        hired({ applicationId: 80, bonusEligibleAt: new Date(NOW.getTime() + DAY) });
        const summary = await svc.runReferralBonusJob({ now: NOW });
        expect(summary).toMatchObject({ scanned: 2, forfeited: 1, awaitingHandoff: 1, eligible: 0 });
        const byApp = Object.fromEntries(f.all("internalReferral").map((r) => [r.applicationId, r]));
        expect(byApp[78]).toMatchObject({ bonusStatus: "FORFEITED", bonusDecidedById: null, bonusDecidedAt: NOW });
        expect(byApp[79].bonusStatus).toBe("PENDING");
        expect(byApp[80].bonusStatus).toBe("PENDING");
        expect(f.events()).toHaveLength(0);
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ notes: expect.stringContaining("HIRE_SEPARATED") }));
    });

    it("settles each tenant under its own context and isolates a failing row", async () => {
        hired();
        handoffFor(77, HIRE);
        f.seed("employee", { id: 301, tenant_id: T2, status: "Active", employement_status: "Active" });
        f.seed("internalReferral", { tenantId: T2, requisitionId: 5, referrerEmployeeId: 9, applicationId: 90, status: "HIRED", bonusStatus: "PENDING", bonusEligibleAt: new Date(NOW.getTime() - DAY) });
        handoffFor(90, 301, T2);
        hired({ applicationId: 91 });
        const realOffer = f.db.offer.findFirst;
        f.db.offer.findFirst = (args) => (args?.where?.applicationId === 91 ? Promise.reject(new Error("boom")) : realOffer(args));
        const summary = await svc.runReferralBonusJob({ now: NOW });
        expect(summary).toMatchObject({ scanned: 3, eligible: 2, errors: 1 });
        expect(f.events().map((e) => e.tenantId).sort()).toEqual([T1, T2].sort());
    });
});
