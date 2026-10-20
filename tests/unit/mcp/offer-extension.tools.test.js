// tests/unit/mcp/offer-extension.tools.test.js
//
// Recruitment Phase 6 (stream C) — the extension re-approval tools: get is
// GET and withdraw is PUT on hr:recruitment; both pass the caller's scope (the
// service keeps them ORG-only and flag-gated) and the withdraw names the
// caller as the actor, never a supplied id.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const getOfferExtensionApproval = jest.fn(async () => ({ offerId: 9, open: true, latest: { stage: "HR" } }));
const withdrawOfferExtension = jest.fn(async () => ({ offerId: 9, withdrawn: [{ stage: "WITHDRAWN" }] }));

jest.unstable_mockModule("../../../src/services/offer-expiry.service.js", () => ({ getOfferExtensionApproval, withdrawOfferExtension }));

const { registerOfferExtensionTools } = await import("../../../src/mcp/tools/offer-extension.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerOfferExtensionTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const TENANT = "tenant-A";
const RECRUITER = { roles: ["RECRUITER"], employeeId: 7, tenantId: TENANT, isAdmin: false };
const call = (name, args, permissions = { "hr:recruitment": ["VIEW", "EDIT"] }) =>
    mcpCtx.run({ user: RECRUITER, permissions }, async () => await handlers.get(name)(args));
const body = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe("offer extension tools", () => {
    it("registers the two tools", () => {
        expect([...handlers.keys()].sort()).toEqual(["hr_offer_expiry_extension_get", "hr_offer_expiry_extension_withdraw"]);
    });

    it("get reads with the caller's tenant and scope", async () => {
        const res = await call("hr_offer_expiry_extension_get", { id: "9" }, { "hr:recruitment": ["VIEW"] });
        expect(body(res)).toMatchObject({ offerId: 9, open: true });
        expect(getOfferExtensionApproval).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, id: "9", scope: expect.objectContaining({ unrestricted: true }) }));
    });

    it("withdraw needs PUT and acts as the caller", async () => {
        const res = await call("hr_offer_expiry_extension_withdraw", { id: 9, reason: "No longer needed" });
        expect(body(res).withdrawn).toHaveLength(1);
        expect(withdrawOfferExtension).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, id: 9, reason: "No longer needed", actorId: 7 }));

        withdrawOfferExtension.mockClear();
        expect((await call("hr_offer_expiry_extension_withdraw", { id: 9 }, { "hr:recruitment": ["VIEW"] })).isError).toBe(true);
        expect(withdrawOfferExtension).not.toHaveBeenCalled();
    });
});
