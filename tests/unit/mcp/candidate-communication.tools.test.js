// Recruitment Phase 2 — the candidate communication tools over the real
// service and an in-memory store: manual send (ORG only, idempotent on
// clientRequestId, 503 with the flag off), cancel, list scoping, templates.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createFakeDb, createRecordingLogger } from "../services/candidate-communication.fakes.js";

const { db, store } = createFakeDb();
const { logger } = createRecordingLogger();
const getRecruitmentSettings = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: logger }));
jest.unstable_mockModule("../../../src/services/recruitment-settings.service.js", () => ({ getRecruitmentSettings }));
jest.unstable_mockModule("../../../src/services/candidateVerification.service.js", () => ({
    PORTAL_STATUS_REQUEST_PATH: "/status",
}));

const { registerCandidateCommunicationTools } = await import("../../../src/mcp/tools/candidate-communication.tools.js");
const service = await import("../../../src/services/candidate-communication.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T12:00:00Z");

const handlers = new Map();
registerCandidateCommunicationTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const PERMS = ["hr.recruitment.read", "hr.recruitment.create", "hr.recruitment.update"];
const RECRUITER = { roles: ["RECRUITER"], employeeId: 5, tenantId: TENANT, isAdmin: false };
const MANAGER = { roles: ["HIRING_MANAGER"], employeeId: 42, tenantId: TENANT, isAdmin: false };

const call = (name, args, { user = RECRUITER, permissions = PERMS } = {}) =>
    mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);
// Direct service calls run inside the caller's request context, as the tools do.
const asRecruiter = (fn) => mcpCtx.run({ user: RECRUITER, permissions: PERMS }, async () => await fn());

const application = (over = {}) => ({
    id: 901,
    tenantId: TENANT,
    candidateId: 77,
    jobRequisitionId: 9,
    stage: "offer",
    candidate: { id: 77, firstName: "Zoe" },
    jobRequisition: { id: 9, title: "Sales Lead", requestedById: 42, approvedById: null },
    offer: { id: 11, status: "SENT" },
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(store)) store[key].length = 0;
    db.contextLog.length = 0;
    process.env.HR_RECRUITMENT_COMMUNICATIONS = "true";
    getRecruitmentSettings.mockResolvedValue({ rejectionDelayHours: 48, companyName: "Trusoft", portalBaseUrl: null });
    store.applications.push(application(), application({ id: 902, jobRequisitionId: 10, stage: "screening", offer: null, jobRequisition: { id: 10, title: "Ops", requestedById: 99 } }));
    store.candidates.push({ id: 77, tenantId: TENANT, firstName: "Zoe", email: "zoe@example.com", applications: store.applications });
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_COMMUNICATIONS;
});

describe("registration", () => {
    it("registers the four tools", () => {
        expect([...handlers.keys()].sort()).toEqual([
            "hr_candidate_communication_cancel",
            "hr_candidate_communication_send",
            "hr_candidate_communications_list",
            "hr_recruitment_communication_templates_list",
        ]);
    });
});

describe("hr_candidate_communication_send", () => {
    const send = (over = {}, opts) =>
        call("hr_candidate_communication_send", { applicationId: "901", templateId: "offer.sent", clientRequestId: "req-1", ...over }, opts);

    it("queues a personalised offer message through the delivery path", async () => {
        const res = parse(await send({ personalNote: "  <b>Welcome</b>   aboard!\u0007 " }));
        expect(res.replayed).toBe(false);
        expect(res.communication).toMatchObject({ status: "QUEUED", category: "OFFER", templateId: "offer.sent", hasPersonalNote: true });
        const [row] = store.communications;
        expect(row).toMatchObject({
            tenantId: TENANT,
            dedupeKey: "manual:901:offer.sent:req-1",
            eventId: null,
            createdById: 5,
            applicationId: 901,
        });
        expect(row.data).toMatchObject({ personalNote: "Welcome aboard!", candidateFirstName: "Zoe", companyName: "Trusoft" });
        expect(JSON.stringify(row.data)).not.toContain("zoe@example.com");
        // The list never echoes the message data.
        expect(JSON.stringify(res)).not.toContain("Welcome");
        for (const entry of db.contextLog) expect(entry).toMatchObject({ tenantId: TENANT });
    });

    it("is idempotent on clientRequestId", async () => {
        const first = parse(await send());
        const again = parse(await send());
        expect(again.replayed).toBe(true);
        expect(again.communication.id).toBe(first.communication.id);
        expect(store.communications).toHaveLength(1);
        parse(await send({ clientRequestId: "req-2" }));
        expect(store.communications).toHaveLength(2);
    });

    it("returns the winner when a concurrent retry beat the insert", async () => {
        const scope = resolveRecruitmentScope(RECRUITER);
        const args = { tenantId: TENANT, scope, applicationId: 901, templateId: "general.update", clientRequestId: "r", now: NOW };
        const [a, b] = await asRecruiter(() =>
            Promise.all([service.sendManualCandidateCommunication(args), service.sendManualCandidateCommunication(args)]),
        );
        expect(store.communications).toHaveLength(1);
        expect(a.communication.id).toBe(b.communication.id);
        expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    });

    it("replaces an automatic offer message that has not gone out", async () => {
        store.communications.push({
            id: 1, tenantId: TENANT, applicationId: 901, candidateId: 77, templateId: "offer.sent", category: "OFFER",
            eventId: "evt-1", status: "QUEUED", dedupeKey: "evt-1:offer.sent", data: {}, claimExpiresAt: null,
        });
        const res = parse(await send());
        expect(res.superseded).toBe(1);
        expect(store.communications[0]).toMatchObject({ status: "CANCELLED", data: { cancellation: { reason: "SUPERSEDED_BY_PERSONALISED_MESSAGE" } } });
    });

    it("requires a clientRequestId", async () => {
        const res = parse(await send({ clientRequestId: "has spaces" }));
        expect(res.status).toBe(400);
        expect(store.communications).toHaveLength(0);
    });

    it("is ORG only", async () => {
        const res = parse(await send({}, { user: MANAGER }));
        expect(res.status).toBe(403);
        expect(store.communications).toHaveLength(0);
    });

    it("returns 503 when the communications flag is off", async () => {
        process.env.HR_RECRUITMENT_COMMUNICATIONS = "false";
        const res = parse(await send());
        expect(res.status).toBe(503);
        await expect(
            asRecruiter(() => service.sendManualCandidateCommunication({
                tenantId: TENANT, scope: resolveRecruitmentScope(RECRUITER), applicationId: 901, templateId: "offer.sent", clientRequestId: "x",
            })),
        ).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-COMMUNICATIONS-DISABLED" });
    });

    it("needs the permission", async () => {
        const res = parse(await send({}, { permissions: ["hr.recruitment.read"] }));
        expect(res.status).toBe(403);
    });

    it("refuses templates that do not fit the application", async () => {
        const scope = resolveRecruitmentScope(RECRUITER);
        const base = { tenantId: TENANT, scope, clientRequestId: "x" };
        const sendAs = (args) => asRecruiter(() => service.sendManualCandidateCommunication(args));
        await expect(sendAs({ ...base, applicationId: 902, templateId: "offer.sent" }))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-COMMUNICATION-TEMPLATE-STAGE" });
        await expect(sendAs({ ...base, applicationId: 901, templateId: "application.rejected" }))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-COMMUNICATION-TEMPLATE-INVALID" });
        await expect(sendAs({ ...base, applicationId: 902, templateId: "application.stage.screening", personalNote: "hi" }))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-COMMUNICATION-NOTE-NOT-ALLOWED" });
        await expect(sendAs({ ...base, applicationId: 901, templateId: "general.update", personalNote: "x".repeat(1001) }))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-COMMUNICATION-NOTE-TOO-LONG" });
        store.applications[1].stage = "withdrawn";
        await expect(sendAs({ ...base, applicationId: 902, templateId: "general.update" }))
            .rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-APPLICATION-WITHDRAWN" });
        store.applications[0].offer = { id: 11, status: "DRAFT" };
        await expect(sendAs({ ...base, applicationId: 901, templateId: "offer.sent" }))
            .rejects.toMatchObject({ code: "HR-RECRUITMENT-COMMUNICATION-OFFER-NOT-SENT" });
        expect(store.communications).toHaveLength(0);
    });

    it("does not reach an application of another tenant", async () => {
        store.applications[0].tenantId = OTHER;
        const res = parse(await send());
        expect(res.status).toBe(404);
    });
});

describe("hr_candidate_communication_cancel", () => {
    const seed = (over = {}) => {
        const row = {
            id: store.communications.length + 1, tenantId: TENANT, candidateId: 77, applicationId: 901,
            templateId: "application.rejected", category: "REJECTION", status: "QUEUED", dedupeKey: `k${store.communications.length}`,
            data: { candidateFirstName: "Zoe" }, claimedBy: null, claimExpiresAt: null, ...over,
        };
        store.communications.push(row);
        return row;
    };

    it("cancels a queued delayed rejection with the reason", async () => {
        const row = seed();
        const res = parse(await call("hr_candidate_communication_cancel", { id: String(row.id), reason: "Spoke to the candidate by phone" }));
        expect(res.communication).toMatchObject({ status: "CANCELLED", cancelReason: "Spoke to the candidate by phone" });
        expect(store.communications[0].data.cancellation).toMatchObject({ cancelledById: 5 });
    });

    it("refuses a message that is not queued, or is being sent", async () => {
        const sent = seed({ status: "SENT" });
        const inFlight = seed({ claimedBy: "w", claimExpiresAt: new Date(Date.now() + 60_000) });
        expect(parse(await call("hr_candidate_communication_cancel", { id: sent.id, reason: "r" })).status).toBe(409);
        expect(parse(await call("hr_candidate_communication_cancel", { id: inFlight.id, reason: "r" })).status).toBe(409);
        expect(store.communications.map((r) => r.status)).toEqual(["SENT", "QUEUED"]);
    });

    it("is ORG only and tenant-scoped", async () => {
        const row = seed();
        expect(parse(await call("hr_candidate_communication_cancel", { id: row.id, reason: "r" }, { user: MANAGER })).status).toBe(403);
        store.communications[0].tenantId = OTHER;
        expect(parse(await call("hr_candidate_communication_cancel", { id: row.id, reason: "r" })).status).toBe(404);
    });
});

describe("hr_candidate_communications_list", () => {
    beforeEach(() => {
        store.communications.push(
            { id: 1, tenantId: TENANT, candidateId: 77, applicationId: 901, templateId: "offer.sent", category: "OFFER", status: "SENT", suppressedReason: null, data: { personalNote: "secret note" }, dedupeKey: "a" },
            { id: 2, tenantId: TENANT, candidateId: 77, applicationId: 902, templateId: "application.rejected", category: "REJECTION", status: "SUPPRESSED", suppressedReason: "DNC", data: {}, dedupeKey: "b" },
            { id: 3, tenantId: OTHER, candidateId: 77, applicationId: 901, templateId: "offer.sent", category: "OFFER", status: "SENT", data: {}, dedupeKey: "c" },
        );
    });

    it("lists a candidate's log for a recruiter, without message data", async () => {
        const res = parse(await call("hr_candidate_communications_list", { candidateId: "77" }));
        expect(res.total).toBe(2);
        expect(res.items.map((i) => i.id).sort()).toEqual([1, 2]);
        expect(res.items.find((i) => i.id === 2)).toMatchObject({ status: "SUPPRESSED", suppressedReason: "DNC" });
        expect(JSON.stringify(res)).not.toMatch(/secret note|zoe@example/);
        expect(res.items.find((i) => i.id === 1).hasPersonalNote).toBe(true);
    });

    it("cuts a hiring manager to the applications on their own requisitions", async () => {
        const res = parse(await call("hr_candidate_communications_list", { candidateId: "77" }, { user: MANAGER }));
        expect(res.items.map((i) => i.id)).toEqual([1]);
        const other = parse(await call("hr_candidate_communications_list", { applicationId: "902" }, { user: MANAGER }));
        expect(other.status).toBe(404);
    });

    it("lists by application and needs a target", async () => {
        const res = parse(await call("hr_candidate_communications_list", { applicationId: "902" }));
        expect(res.items.map((i) => i.id)).toEqual([2]);
        expect(parse(await call("hr_candidate_communications_list", {})).status).toBe(400);
    });

    it("works with the flag off", async () => {
        process.env.HR_RECRUITMENT_COMMUNICATIONS = "false";
        expect(parse(await call("hr_candidate_communications_list", { applicationId: "901" })).total).toBe(1);
    });
});

describe("hr_recruitment_communication_templates_list", () => {
    it("lists the catalogue regardless of the flag", async () => {
        process.env.HR_RECRUITMENT_COMMUNICATIONS = "false";
        const res = parse(await call("hr_recruitment_communication_templates_list", {}));
        expect(res.items.find((t) => t.id === "application.rejected")).toMatchObject({
            category: "REJECTION",
            events: ["hr.recruitment.application_stage_changed.v1"],
            manual: false,
        });
    });
});
