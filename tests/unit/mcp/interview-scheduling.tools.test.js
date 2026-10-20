// Recruitment Phase 3a — the scheduling tools: registration, the HTTP method
// each one checks on hr:recruitment, and the tenant, scope and actor each
// passes to its service.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const proposeSlots = jest.fn(async () => ({ saved: false, slots: [] }));
const sendSlotOffer = jest.fn(async () => ({ id: 1, status: "SENT" }));
const cancelSlotOffer = jest.fn(async () => ({ id: 1, status: "CANCELLED" }));
const listSlotOffers = jest.fn(async () => ({ items: [], total: 0 }));
const markNoShow = jest.fn(async () => ({ interviewId: 40, status: "NO_SHOW" }));
const requeueInterviewCalendarSync = jest.fn(async () => ({ interviewId: 40, calendarSyncStatus: "PENDING" }));

jest.unstable_mockModule("../../../src/services/interview-slot-offer.service.js", () => ({
    INTERVIEW_TYPES: ["PHONE_SCREEN", "TECHNICAL", "BEHAVIORAL", "PANEL", "FINAL", "ONSITE", "VIDEO"],
    SLOT_OFFER_STATUS: { PROPOSED: "PROPOSED", SENT: "SENT", CONFIRMED: "CONFIRMED", EXPIRED: "EXPIRED", CANCELLED: "CANCELLED" },
    proposeSlots,
    sendSlotOffer,
    cancelSlotOffer,
    listSlotOffers,
}));
jest.unstable_mockModule("../../../src/services/interviewSchedule.service.js", () => ({ markNoShow }));
jest.unstable_mockModule("../../../src/services/interview-calendar-sync.service.js", () => ({ requeueInterviewCalendarSync }));

const { registerInterviewSchedulingTools } = await import("../../../src/mcp/tools/interview-scheduling.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const schemas = new Map();
registerInterviewSchedulingTools({
    tool: (name, _desc, schema, handler) => {
        handlers.set(name, handler);
        schemas.set(name, schema);
    },
});

const TENANT = "11111111-1111-4111-8111-111111111111";
const RECRUITER = { userId: "1", roles: ["RECRUITER"], isAdmin: false, employeeId: 7, tenantId: TENANT };
const MANAGER = { userId: "2", roles: ["HIRING_MANAGER"], isAdmin: false, employeeId: 42, tenantId: TENANT };
const grant = (action) => ({ "hr:recruitment": [action] });
const call = (name, args, { user = RECRUITER, permissions } = {}) =>
    mcpCtx.run({ user, permissions: permissions ?? {} }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
    ["hr_interview_slots_propose", "CREATE", { applicationId: 9, interviewerIds: [3] }],
    ["hr_interview_slot_offer_send", "CREATE", { slotOfferId: 1 }],
    ["hr_interview_slot_offer_cancel", "EDIT", { slotOfferId: 1, reason: "Role on hold" }],
    ["hr_interview_slot_offers_list", "VIEW", { applicationId: 9 }],
    ["hr_interview_no_show", "EDIT", { interviewId: 40 }],
    ["hr_interview_calendar_resync", "CREATE", { interviewId: 40 }],
];

beforeEach(() => jest.clearAllMocks());

describe("registration and permission method", () => {
    it("registers exactly the six Phase 3a tools", () => {
        expect([...handlers.keys()].sort()).toEqual(TOOLS.map(([name]) => name).sort());
    });

    it.each(TOOLS)("%s requires hr:recruitment %s", async (name, action, args) => {
        const denied = await call(name, args, { permissions: {} });
        expect(denied.isError).toBe(true);
        expect(parse(denied).status).toBe(403);
        const wrong = await call(name, args, { permissions: grant(action === "VIEW" ? "EDIT" : "VIEW") });
        expect(wrong.isError).toBe(true);
        const ok = await call(name, args, { permissions: grant(action) });
        expect(ok.isError).toBeUndefined();
    });

    it("a forged isAdmin grants nothing", async () => {
        const res = await call("hr_interview_slot_offer_send", { slotOfferId: 1 }, { user: { ...MANAGER, isAdmin: true } });
        expect(parse(res).status).toBe(403);
    });
});

describe("what each tool hands its service", () => {
    it("propose passes the verified tenant, scope, actor and save flag", async () => {
        await call("hr_interview_slots_propose", { applicationId: 9, interviewerIds: [3, 4], count: 3, save: true }, { user: MANAGER, permissions: grant("CREATE") });
        expect(proposeSlots).toHaveBeenCalledWith(expect.objectContaining({
            applicationId: 9,
            interviewerIds: [3, 4],
            count: 3,
            save: true,
            tenantId: TENANT,
            actorId: 42,
            scope: expect.objectContaining({ level: "MANAGED", employeeId: 42 }),
        }));
    });

    it("send, cancel, list, no-show and resync carry the scope", async () => {
        await call("hr_interview_slot_offer_send", { applicationId: 9, interviewerIds: [3], slots: ["2026-10-20T04:00:00Z"] }, { permissions: grant("CREATE") });
        expect(sendSlotOffer).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, actorId: 7, scope: expect.objectContaining({ level: "ORG" }), slots: ["2026-10-20T04:00:00Z"] }));

        await call("hr_interview_slot_offer_cancel", { slotOfferId: 1, reason: "Role on hold" }, { permissions: grant("EDIT") });
        expect(cancelSlotOffer).toHaveBeenCalledWith(expect.objectContaining({ slotOfferId: 1, reason: "Role on hold", tenantId: TENANT, actorId: 7 }));

        await call("hr_interview_slot_offers_list", { requisitionId: 21, status: "SENT" }, { permissions: grant("VIEW") });
        expect(listSlotOffers).toHaveBeenCalledWith(expect.objectContaining({ requisitionId: 21, status: "SENT", tenantId: TENANT, scope: expect.any(Object) }));

        await call("hr_interview_no_show", { interviewId: 40, notes: "No answer" }, { permissions: grant("EDIT") });
        expect(markNoShow).toHaveBeenCalledWith(expect.objectContaining({ interviewId: 40, notes: "No answer", tenantId: TENANT, actorId: 7, scope: expect.any(Object) }));

        await call("hr_interview_calendar_resync", { interviewId: 40 }, { permissions: grant("CREATE") });
        expect(requeueInterviewCalendarSync).toHaveBeenCalledWith(expect.objectContaining({ interviewId: 40, tenantId: TENANT, scope: expect.any(Object) }));
    });

    it("a service refusal comes back as a tool error with its status", async () => {
        sendSlotOffer.mockRejectedValueOnce(Object.assign(new Error("Candidate self-scheduling is disabled"), { status: 503, code: "HR-RECRUITMENT-SELF-SCHEDULING-DISABLED" }));
        const res = await call("hr_interview_slot_offer_send", { slotOfferId: 1 }, { permissions: grant("CREATE") });
        expect(res.isError).toBe(true);
    });
});
