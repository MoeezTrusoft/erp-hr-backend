// Recruitment Phase 3a — the offer letter and e-signature tools: seven tools,
// each gated on hr:recruitment with its HTTP-method action, passing the
// verified tenant and the caller's recruitment scope to the service.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const letters = {
    listOfferLetterTemplates: jest.fn(async () => ({ items: [] })),
    saveOfferLetterTemplate: jest.fn(async () => ({ id: 1, version: 1 })),
    deactivateOfferLetterTemplate: jest.fn(async () => ({ id: 1, active: false })),
    renderOfferLetterVersion: jest.fn(async () => ({ version: { id: 5 } })),
    listOfferLetterVersions: jest.fn(async () => ({ items: [] })),
};
const esign = {
    sendOfferForSignature: jest.fn(async () => ({ version: { id: 5, signatureStatus: "SENT" } })),
    voidOfferSignature: jest.fn(async () => ({ version: { id: 5, signatureStatus: "VOIDED" } })),
};
jest.unstable_mockModule("../../../src/services/offer-letter.service.js", () => letters);
jest.unstable_mockModule("../../../src/services/offer-esign.service.js", () => esign);

const { registerOfferLetterTools } = await import("../../../src/mcp/tools/offer-letter.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerOfferLetterTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const TENANT = "11111111-1111-4111-8111-111111111111";
const RECRUITER = { roles: ["RECRUITER"], employeeId: 7, tenantId: TENANT, isAdmin: false };
const ALL = { "hr:recruitment": ["VIEW", "CREATE", "EDIT"] };

const call = (name, args, permissions = ALL, user = RECRUITER) =>
    mcpCtx.run({ user, permissions }, async () => await handlers.get(name)(args));

beforeEach(() => jest.clearAllMocks());

describe("offer letter tools", () => {
    it("registers exactly the seven tools", () => {
        expect([...handlers.keys()].sort()).toEqual([
            "hr_offer_esign_send",
            "hr_offer_esign_void",
            "hr_offer_letter_render",
            "hr_offer_letter_template_deactivate",
            "hr_offer_letter_template_save",
            "hr_offer_letter_templates_list",
            "hr_offer_letter_versions_list",
        ]);
    });

    it.each([
        ["hr_offer_letter_templates_list", "VIEW", {}, letters.listOfferLetterTemplates],
        ["hr_offer_letter_versions_list", "VIEW", { offerId: 1 }, letters.listOfferLetterVersions],
        ["hr_offer_letter_template_save", "EDIT", { key: "STANDARD", name: "n", body: "b" }, letters.saveOfferLetterTemplate],
        ["hr_offer_letter_template_deactivate", "EDIT", { id: 3 }, letters.deactivateOfferLetterTemplate],
        ["hr_offer_letter_render", "CREATE", { offerId: 1 }, letters.renderOfferLetterVersion],
        ["hr_offer_esign_send", "CREATE", { offerId: 1, employeeCategory: "EMPLOYEE" }, esign.sendOfferForSignature],
        ["hr_offer_esign_void", "EDIT", { offerId: 1, reason: "x" }, esign.voidOfferSignature],
    ])("%s needs hr:recruitment %s", async (name, action, args, service) => {
        const others = ["VIEW", "CREATE", "EDIT"].filter((a) => a !== action);
        const denied = await call(name, args, { "hr:recruitment": others });
        expect(denied.isError).toBe(true);
        expect(service).not.toHaveBeenCalled();

        const ok = await call(name, args, { "hr:recruitment": [action] });
        expect(ok.isError).toBeFalsy();
        expect(service).toHaveBeenCalledTimes(1);
        const passed = service.mock.calls[0][0];
        expect(passed.tenantId).toBe(TENANT);
        expect(passed.scope).toMatchObject({ level: "ORG", employeeId: 7 });
    });

    it("passes render and send options through", async () => {
        await call("hr_offer_letter_render", { offerId: "12", templateKey: "CONTRACT", preview: true });
        expect(letters.renderOfferLetterVersion).toHaveBeenCalledWith(expect.objectContaining({ offerId: "12", templateKey: "CONTRACT", preview: true, actorId: 7 }));
        await call("hr_offer_esign_send", { offerId: 12, employeeCategory: "INTERNEE", message: "Hi" });
        expect(esign.sendOfferForSignature).toHaveBeenCalledWith(expect.objectContaining({ offerId: 12, employeeCategory: "INTERNEE", message: "Hi", actorId: 7 }));
    });

    it("maps a service refusal to a tool error", async () => {
        esign.sendOfferForSignature.mockRejectedValueOnce(Object.assign(new Error("Offer e-signature is disabled"), { status: 503, code: "HR-RECRUITMENT-ESIGN-DISABLED" }));
        const res = await call("hr_offer_esign_send", { offerId: 1 });
        expect(res.isError).toBe(true);
        expect(JSON.stringify(res)).toContain("HR-5031");
    });
});
