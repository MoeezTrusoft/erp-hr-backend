// tests/unit/mcp/offer-lifecycle.tools.test.js
//
// Recruitment Phase 3a — the offer lifecycle tools: decline record and extend
// are PUT on hr:recruitment and ORG-only; the reasons list is GET for any
// scope; the band check is GET and limited to scopes that may see
// compensation.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const respondOffer = jest.fn(async () => ({
    offer: { id: 9, status: "DECLINED", salary: 100, currency: "PKR", compensation: {} },
    handoff: null,
    replayed: false,
    declineReason: "TIMING",
    talentPool: null,
}));
const extendOfferExpiry = jest.fn(async () => ({ id: 9, status: "SENT", salary: 100, reopened: false }));
const checkOfferSalaryBand = jest.fn(async () => ({
    requisitionFound: true,
    band: { gradeLevelId: 3, gradeName: "G5", min: 100, max: 150, currency: "PKR" },
    hasBand: true,
    comparable: true,
    reason: null,
    warnings: [{ code: "SALARY_BELOW_BAND", min: 100, max: 150 }],
}));

jest.unstable_mockModule("../../../src/services/offer.service.js", () => ({ respondOffer }));
jest.unstable_mockModule("../../../src/services/offer-expiry.service.js", () => ({
    extendOfferExpiry,
    MAX_EXTENSION_DAYS: 60,
    REOPEN_WINDOW_DAYS: 7,
}));
jest.unstable_mockModule("../../../src/services/offerMgmt.service.js", () => ({ checkOfferSalaryBand }));

const { registerOfferLifecycleTools } = await import("../../../src/mcp/tools/offer-lifecycle.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerOfferLifecycleTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const TENANT = "tenant-A";
const RECRUITER = { roles: ["RECRUITER"], employeeId: 7, tenantId: TENANT, isAdmin: false };
const MANAGER = { roles: ["HIRING_MANAGER"], employeeId: 8, tenantId: TENANT, isAdmin: false };
const FINANCE = { roles: ["FINANCE"], employeeId: 9, tenantId: TENANT, isAdmin: false };
const PERMS = { "hr:recruitment": ["VIEW", "EDIT"] };

const call = (name, args, user = RECRUITER, permissions = PERMS) =>
    mcpCtx.run({ user, permissions }, async () => await handlers.get(name)(args));
const body = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe("offer lifecycle tools", () => {
    it("registers exactly the four tools", () => {
        expect([...handlers.keys()].sort()).toEqual([
            "hr_offer_band_check",
            "hr_offer_decline_reasons_list",
            "hr_offer_decline_record",
            "hr_offer_expiry_extend",
        ]);
    });

    it("decline record: a recruiter records through respondOffer with the reason required", async () => {
        const res = await call("hr_offer_decline_record", { id: "9", declineReasonCode: "TIMING", talentPoolOptIn: true });
        expect(res.isError).not.toBe(true);
        expect(respondOffer).toHaveBeenCalledWith("9", false, TENANT, {
            actorId: 7,
            declineReasonCode: "TIMING",
            declineNote: undefined,
            talentPoolOptIn: true,
            requireDeclineReason: true,
        });
        expect(body(res).declineReason).toBe("TIMING");
    });

    it("decline record: a hiring manager or a caller without PUT is refused", async () => {
        expect((await call("hr_offer_decline_record", { id: "9", declineReasonCode: "TIMING" }, MANAGER)).isError).toBe(true);
        expect((await call("hr_offer_decline_record", { id: "9", declineReasonCode: "TIMING" }, RECRUITER, { "hr:recruitment": ["VIEW"] })).isError).toBe(true);
        expect(respondOffer).not.toHaveBeenCalled();
    });

    it("reasons list: the vocabulary with labels, OTHER needs a note", async () => {
        const res = await call("hr_offer_decline_reasons_list", {}, MANAGER, { "hr:recruitment": ["VIEW"] });
        const { items, noteMaxLength } = body(res);
        expect(items).toHaveLength(9);
        expect(items.find((i) => i.code === "OTHER")).toMatchObject({ noteRequired: true });
        expect(items.every((i) => i.label)).toBe(true);
        expect(noteMaxLength).toBe(1000);
    });

    it("extend: a recruiter extends; a hiring manager is refused before the service", async () => {
        const res = await call("hr_offer_expiry_extend", { id: 9, expiryDate: "2026-11-01", expectedVersion: 3 });
        expect(res.isError).not.toBe(true);
        expect(extendOfferExpiry).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, id: 9, expiryDate: "2026-11-01", expectedVersion: 3, actorId: 7 }));

        extendOfferExpiry.mockClear();
        expect((await call("hr_offer_expiry_extend", { id: 9, expiryDate: "2026-11-01" }, MANAGER)).isError).toBe(true);
        expect(extendOfferExpiry).not.toHaveBeenCalled();
    });

    it("band check: finance and recruiters see the band; a hiring manager cannot probe it", async () => {
        const res = await call("hr_offer_band_check", { jobRequisitionId: "4", baseSalary: 90, currency: "PKR" }, FINANCE, { "hr:recruitment": ["VIEW"] });
        expect(body(res)).toMatchObject({ jobRequisitionId: 4, withinBand: false, warnings: [{ code: "SALARY_BELOW_BAND" }], band: { min: 100, max: 150 } });

        checkOfferSalaryBand.mockClear();
        const refused = await call("hr_offer_band_check", { jobRequisitionId: "4", baseSalary: 90 }, MANAGER);
        expect(refused.isError).toBe(true);
        expect(checkOfferSalaryBand).not.toHaveBeenCalled();
    });

    it("band check: an unknown requisition is not found", async () => {
        checkOfferSalaryBand.mockResolvedValueOnce({ requisitionFound: false, band: null, comparable: false, reason: "NO_BAND", warnings: [] });
        expect((await call("hr_offer_band_check", { jobRequisitionId: "404", baseSalary: 90 })).isError).toBe(true);
    });
});
