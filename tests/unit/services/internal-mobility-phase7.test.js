// Recruitment Phase 7 (C10) — names next to ids on the internal board and on
// HR's referral reads:
//   * the HR referral list and the bonus decision's answer carry referrerName
//     and bonusDecidedByName beside the ids (one employee lookup per read,
//     under the caller's tenant; another tenant's id reads null);
//   * the board rows carry departmentName beside departmentId, from the
//     department model (BusinessUnit) under the caller's tenant.
import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";

import { makeInternalMobilityDb } from "./helpers/internal-mobility.fake.js";

const fake = { current: null };
const dbProxy = new Proxy({}, { get: (_t, key) => fake.current.db[key] });

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: dbProxy, prisma: dbProxy }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: dbProxy }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/services/intake-dnc.service.js", () => ({
    checkIntakeDnc: async () => ({ blocked: false, reason: null }),
    logIntakeSuppressed: () => undefined,
}));
jest.unstable_mockModule("../../../src/services/applicationService.js", () => ({ createApplicationInTx: jest.fn() }));

const referrals = await import("../../../src/services/internal-referral.service.js");
const board = await import("../../../src/services/internal-board.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const REFERRER = 101;
const HR = 160;
const ME = 120;
const NOW = new Date("2026-10-20T09:00:00Z");

const asUser = (fn, { tenantId = T1, employeeId = HR } = {}) =>
    mcpCtx.run({ user: { tenantId, employeeId } }, async () => await fn());
const employeeReads = (f) => f.state.ops.filter((op) => op.model === "employee" && op.op === "findMany");

let f;
let reqA;
beforeEach(() => {
    process.env.HR_RECRUITMENT_INTERNAL_BOARD = "true";
    f = makeInternalMobilityDb();
    fake.current = f;
    reqA = f.seed("jobRequisition", { tenantId: T1, title: "Backend Engineer", requestedById: 102, recruiterId: 7, departmentId: 7 }).id;
    f.seed("employee", { id: REFERRER, tenant_id: T1, first_name: "Sara", last_name: "Ali", work_email: "sara@acme.test", status: "Active" });
    f.seed("employee", { id: HR, tenant_id: T1, first_name: "", last_name: "", employee_name: "Hina HR", status: "Active" });
    f.seed("employee", { id: ME, tenant_id: T1, first_name: "Me", last_name: "Myself", status: "Active", separatedAt: null });
    f.seed("employee", { id: 301, tenant_id: T2, first_name: "Foreign", last_name: "Person", status: "Active" });
});
afterAll(() => {
    delete process.env.HR_RECRUITMENT_INTERNAL_BOARD;
});

const referral = (extra = {}) =>
    f.seed("internalReferral", { tenantId: T1, requisitionId: reqA, referrerEmployeeId: REFERRER, candidateId: 1, applicationId: 77, ...extra });

describe("referral reads name the referrer and the bonus decider", () => {
    it("the HR list carries referrerName and bonusDecidedByName next to the ids, in one lookup", async () => {
        referral({ bonusDecidedById: HR, bonusStatus: "APPROVED", status: "HIRED" });
        referral({ referrerEmployeeId: 301 });
        const page = await asUser(() => referrals.listReferrals({ tenantId: T1, scope: resolveRecruitmentScope({ roles: ["RECRUITER"], employeeId: HR }) }));
        const [foreign, named] = page.items;
        expect(named).toMatchObject({ referrerEmployeeId: REFERRER, referrerName: "Sara Ali", bonusDecidedById: HR, bonusDecidedByName: "Hina HR" });
        // An id that does not resolve in the caller's tenant keeps its id and has no name.
        expect(foreign).toMatchObject({ referrerEmployeeId: 301, referrerName: null, bonusDecidedByName: null });
        const reads = employeeReads(f);
        expect(reads).toHaveLength(1);
        expect(reads[0].tenant).toBe(T1);
        expect(JSON.stringify(page)).not.toContain("sara@acme.test");
    });

    it("a manager's list (MANAGED scope) names the referrer too", async () => {
        referral();
        const page = await asUser(
            () => referrals.listReferrals({ tenantId: T1, scope: resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 102 }) }),
            { employeeId: 102 },
        );
        expect(page.items[0]).toMatchObject({ referrerName: "Sara Ali" });
    });

    it("the bonus decision answers with both names", async () => {
        const r = referral({ status: "HIRED", bonusStatus: "ELIGIBLE" });
        const out = await asUser(() => referrals.updateReferralBonus({
            tenantId: T1, referralId: r.id, expectedVersion: 0, bonusStatus: "APPROVED", amount: "100", currency: "PKR", actorId: HR, now: NOW,
        }));
        expect(out).toMatchObject({ referrerName: "Sara Ali", bonusDecidedById: HR, bonusDecidedByName: "Hina HR" });
    });

    it("an empty page asks for no names", async () => {
        const page = await asUser(() => referrals.listReferrals({ tenantId: T1, scope: resolveRecruitmentScope({ roles: ["RECRUITER"] }) }));
        expect(page.items).toEqual([]);
        expect(employeeReads(f)).toHaveLength(0);
    });

    it("hrReferralView without names reads null (never throws)", () => {
        const view = referrals.hrReferralView({ id: 1, requisitionId: 2, referrerEmployeeId: REFERRER, status: "SUBMITTED", bonusStatus: "NOT_ELIGIBLE", version: 0 });
        expect(view).toMatchObject({ referrerName: null, bonusDecidedByName: null });
    });
});

describe("board rows carry the department name", () => {
    beforeEach(() => {
        f.seed("jobPosting", { tenantId: T1, requisitionId: reqA, channel: "INTERNAL" });
    });

    it("lists and gets a job with departmentName from the tenant's department", async () => {
        f.seed("businessUnit", { id: 7, tenantId: T1, name: "Engineering" });
        const page = await asUser(() => board.listInternalJobs({ tenantId: T1, employeeId: ME, now: NOW }), { employeeId: ME });
        expect(page.items[0]).toMatchObject({ id: reqA, departmentId: 7, departmentName: "Engineering" });
        const job = await asUser(() => board.getInternalJob({ tenantId: T1, employeeId: ME, requisitionId: reqA, now: NOW }), { employeeId: ME });
        expect(job).toMatchObject({ departmentId: 7, departmentName: "Engineering" });
        const reads = f.state.ops.filter((op) => op.model === "businessUnit");
        expect(reads).toHaveLength(2);
        expect(reads.every((op) => op.tenant === T1)).toBe(true);
    });

    it("another tenant's department, or none, reads null and the id stays", async () => {
        f.seed("businessUnit", { id: 7, tenantId: T2, name: "Foreign Dept" });
        const second = f.seed("jobRequisition", { tenantId: T1, title: "No department", requestedById: 102, departmentId: null });
        f.seed("jobPosting", { tenantId: T1, requisitionId: second.id, channel: "INTERNAL" });
        const page = await asUser(() => board.listInternalJobs({ tenantId: T1, employeeId: ME, now: NOW }), { employeeId: ME });
        const byId = Object.fromEntries(page.items.map((j) => [j.id, j]));
        expect(byId[reqA]).toMatchObject({ departmentId: 7, departmentName: null });
        expect(byId[second.id]).toMatchObject({ departmentId: null, departmentName: null });
        expect(JSON.stringify(page)).not.toContain("Foreign Dept");
    });

    it("departmentNamesById makes no query without ids", async () => {
        expect(await asUser(() => board.departmentNamesById(f.db, T1, [null, undefined, "x"]))).toEqual(new Map());
        expect(f.state.ops.filter((op) => op.model === "businessUnit")).toHaveLength(0);
    });
});
