// Recruitment Phase 7 — the new tools of stream B:
//   * B7 the three DAM download tools (hr:recruitment GET, the caller's
//     recruitment scope / assessment access handed to the service, a DAM
//     outage surfacing as HR-5032);
//   * B5 hr_recruitment_interview_panel_roles_set (hr:recruitment PUT, the
//     caller's scope handed to the service).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const offerLetters = { downloadOfferLetter: jest.fn(async () => ({ offerId: 5, fileName: "a.pdf" })) };
const packet = { downloadPacketDocument: jest.fn(async () => ({ interviewId: 500 })) };
const items = { downloadTestItemPicture: jest.fn(async () => ({ itemId: 30 })) };
const schedule = {
    cancelInterview: jest.fn(),
    requestReschedule: jest.fn(),
    confirmReschedule: jest.fn(),
    checkInterviewerAvailability: jest.fn(),
    markCalendarSync: jest.fn(),
    listLifecycleEvents: jest.fn(),
    setInterviewPanelRoles: jest.fn(async () => ({ interviewId: 500, changed: 1, panel: [] })),
};
jest.unstable_mockModule("../../../src/services/offer-letter.service.js", () => offerLetters);
jest.unstable_mockModule("../../../src/services/interviewPacket.service.js", () => packet);
jest.unstable_mockModule("../../../src/services/test-item.service.js", () => items);
jest.unstable_mockModule("../../../src/services/interviewSchedule.service.js", () => schedule);

const { registerRecruitmentDocumentDownloadTools } = await import("../../../src/mcp/tools/recruitment-document-download.tools.js");
const { registerInterviewMgmtTools } = await import("../../../src/mcp/tools/interviewMgmtTools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const server = { tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) };
registerRecruitmentDocumentDownloadTools(server);
const downloadTools = [...handlers.keys()];
registerInterviewMgmtTools(server);

const TENANT = "11111111-1111-4111-8111-111111111111";
const RECRUITER = { roles: ["RECRUITER"], employeeId: 9, tenantId: TENANT, isAdmin: false };
const ALL = { "hr:recruitment": ["VIEW", "CREATE", "EDIT"] };

const call = (name, args, permissions = ALL, user = RECRUITER) =>
    mcpCtx.run({ user, permissions }, async () => await handlers.get(name)(args));

beforeEach(() => jest.clearAllMocks());

describe("B7 download tools", () => {
    it("registers exactly the three download tools", () => {
        expect(downloadTools.sort()).toEqual([
            "hr_recruitment_interview_packet_document_download",
            "hr_recruitment_offer_letter_download",
            "hr_recruitment_test_item_picture_download",
        ]);
    });

    it.each([
        ["hr_recruitment_offer_letter_download", { offerId: 5, versionId: 70, signed: true }, offerLetters.downloadOfferLetter],
        ["hr_recruitment_interview_packet_document_download", { interviewId: 500, itemId: 1 }, packet.downloadPacketDocument],
        ["hr_recruitment_test_item_picture_download", { itemId: 30 }, items.downloadTestItemPicture],
    ])("%s needs hr:recruitment VIEW and passes the tenant", async (name, args, service) => {
        const denied = await call(name, args, { "hr:recruitment": ["CREATE", "EDIT"] });
        expect(denied.isError).toBe(true);
        expect(service).not.toHaveBeenCalled();

        const ok = await call(name, args, { "hr:recruitment": ["VIEW"] });
        expect(ok.isError).toBeFalsy();
        expect(service).toHaveBeenCalledTimes(1);
        expect(service.mock.calls[0][0].tenantId).toBe(TENANT);
    });

    it("hands the services the caller's scope / assessment access and the picked record", async () => {
        await call("hr_recruitment_offer_letter_download", { offerId: 5, versionId: 70, signed: true });
        expect(offerLetters.downloadOfferLetter.mock.calls[0][0]).toMatchObject({ offerId: 5, versionId: 70, signed: true, scope: { level: "ORG", canSeeCompensation: true } });
        await call("hr_recruitment_interview_packet_document_download", { interviewId: 500, mediaId: 61 });
        expect(packet.downloadPacketDocument.mock.calls[0][0]).toMatchObject({ interviewId: 500, itemId: null, mediaId: 61, viewerEmployeeId: 9, scope: { level: "ORG" } });
        await call("hr_recruitment_test_item_picture_download", { itemId: 30 });
        expect(items.downloadTestItemPicture.mock.calls[0][0].access).toMatchObject({ recruiter: true, employeeId: 9 });
    });

    it("a DAM outage reaches the client as HR-5032 with the domain code", async () => {
        offerLetters.downloadOfferLetter.mockRejectedValueOnce(Object.assign(new Error("dam down"), { status: 502, code: "HR-RECRUITMENT-DOCUMENT-UNAVAILABLE" }));
        const res = await call("hr_recruitment_offer_letter_download", { offerId: 5 });
        expect(res.isError).toBe(true);
        const body = JSON.stringify(res);
        expect(body).toContain("HR-5032");
        expect(body).toContain("HR-RECRUITMENT-DOCUMENT-UNAVAILABLE");
        expect(body).not.toContain("dam down");
    });
});

describe("B5 hr_recruitment_interview_panel_roles_set", () => {
    const args = { interviewId: 500, roles: [{ employeeId: 3, panelRole: "TECHNICAL" }] };

    it("needs hr:recruitment EDIT and passes the scope and the actor", async () => {
        const denied = await call("hr_recruitment_interview_panel_roles_set", args, { "hr:recruitment": ["VIEW", "CREATE"] });
        expect(denied.isError).toBe(true);
        expect(schedule.setInterviewPanelRoles).not.toHaveBeenCalled();

        const ok = await call("hr_recruitment_interview_panel_roles_set", args, { "hr:recruitment": ["EDIT"] });
        expect(ok.isError).toBeFalsy();
        expect(schedule.setInterviewPanelRoles).toHaveBeenCalledWith(expect.objectContaining({
            interviewId: 500, roles: args.roles, tenantId: TENANT, actorId: 9, scope: expect.objectContaining({ level: "ORG" }),
        }));
    });
});
