// Recruitment Phase 4 — the pre-boarding portal tools: registration, the gate
// each checks, the flag, and the pin of every employee-side call to the
// verified caller.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { z } from "zod";

const flag = { on: true };
const assertSelfPortalEnabled = jest.fn(() => {
    if (!flag.on) throw Object.assign(new Error("The onboarding self portal is turned off"), { status: 503, code: "HR-ONBOARDING-SELF-PORTAL-DISABLED" });
});
const getMyOnboarding = jest.fn(async () => ({ checklist: null }));
const completeMyTask = jest.fn(async () => ({ changed: true }));
const reopenMyTask = jest.fn(async () => ({ changed: true }));
const uploadMyDocument = jest.fn(async () => ({ document: { id: 1 } }));
const signMyDocument = jest.fn(async () => ({ document: { id: 1 } }));
const submitMySurvey = jest.fn(async () => ({ survey: { id: 1 } }));
const reviewOnboardingDocument = jest.fn(async () => ({ document: { id: 1 } }));
const listPendingOnboardingDocuments = jest.fn(async () => ({ items: [], total: 0 }));

jest.unstable_mockModule("../../../src/services/onboarding-self.service.js", () => ({
    DOCUMENT_CATEGORY_MAX_LENGTH: 60,
    DOCUMENT_TITLE_MAX_LENGTH: 200,
    REVIEW_DECISIONS: ["VERIFIED", "REJECTED"],
    REVIEW_NOTE_MAX_LENGTH: 1000,
    SELF_SURVEY_TYPES: ["DAY_30", "DAY_60", "DAY_90"],
    SURVEY_RESPONSES_SCHEMA: z.record(z.string(), z.unknown()),
    assertSelfPortalEnabled,
    completeMyTask,
    getMyOnboarding,
    listPendingOnboardingDocuments,
    reopenMyTask,
    reviewOnboardingDocument,
    signMyDocument,
    submitMySurvey,
    uploadMyDocument,
}));

const { registerOnboardingSelfTools, resolveSelfEmployeeId } = await import("../../../src/mcp/tools/onboarding-self.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerOnboardingSelfTools({ tool: (name, _desc, _schema, handler) => handlers.set(name, handler) });

const TENANT = "11111111-1111-4111-8111-111111111111";
const HIRE = { userId: "9", isAdmin: false, employeeId: 101, tenantId: TENANT };
const SELF = { "hr:self": ["VIEW"] };
const call = (name, args, { user = HIRE, permissions = SELF } = {}) =>
    mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

const SELF_TOOLS = [
    ["hr_self_onboarding_get", {}, getMyOnboarding],
    ["hr_self_onboarding_task_complete", { taskId: 5 }, completeMyTask],
    ["hr_self_onboarding_task_reopen", { taskId: 5 }, reopenMyTask],
    ["hr_self_onboarding_document_upload", { title: "CNIC", fileName: "a.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0=" }, uploadMyDocument],
    ["hr_self_onboarding_document_sign", { documentId: 7 }, signMyDocument],
    ["hr_self_onboarding_survey_submit", { type: "DAY_30", responses: { q1: 4 } }, submitMySurvey],
];
const HR_TOOLS = [
    ["hr_onboarding_document_review", "EDIT", { documentId: 7, decision: "VERIFIED" }, reviewOnboardingDocument],
    ["hr_onboarding_documents_pending_list", "VIEW", {}, listPendingOnboardingDocuments],
];

beforeEach(() => {
    flag.on = true;
    jest.clearAllMocks();
});

describe("registration", () => {
    it("registers exactly the eight portal tools", () => {
        expect([...handlers.keys()].sort()).toEqual([...SELF_TOOLS.map(([n]) => n), ...HR_TOOLS.map(([n]) => n)].sort());
    });
});

describe("employee side", () => {
    it.each(SELF_TOOLS)("%s needs hr:self VIEW and passes the caller's own id and tenant", async (name, args, service) => {
        const denied = await call(name, args, { permissions: { "hr:onboarding": ["VIEW", "EDIT"] } });
        expect(parse(denied).status).toBe(403);
        expect(service).not.toHaveBeenCalled();
        const ok = await call(name, args);
        expect(ok.isError).toBeUndefined();
        expect(service).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, employeeId: 101 }));
    });

    it.each(SELF_TOOLS)("%s refuses a different employeeId, even for an admin with HR grants", async (name, args, service) => {
        const res = await call(name, { ...args, employeeId: 102 }, {
            user: { ...HIRE, isAdmin: true },
            permissions: { ...SELF, "hr:onboarding": ["VIEW", "EDIT"], "hr:employee": ["EDIT"] },
        });
        expect(parse(res).status).toBe(403);
        expect(service).not.toHaveBeenCalled();
        const same = await call(name, { ...args, employeeId: "101" });
        expect(same.isError).toBeUndefined();
    });

    it.each(SELF_TOOLS)("%s gives a calm 400 to a session with no employee", async (name, args, service) => {
        const res = await call(name, args, { user: { ...HIRE, employeeId: null } });
        expect(parse(res)).toMatchObject({ status: 400 });
        expect(parse(res).jsonrpc.data.details).toMatchObject({ code: "HR-ONBOARDING-SELF-NO-EMPLOYEE" });
        expect(service).not.toHaveBeenCalled();
    });

    it.each(SELF_TOOLS)("%s answers 503 while the flag is off", async (name, args, service) => {
        flag.on = false;
        const res = await call(name, args);
        expect(parse(res).status).toBe(503);
        expect(parse(res).code).toBe("HR-5031");
        expect(service).not.toHaveBeenCalled();
    });

    it("hands the upload, task, document and survey arguments through", async () => {
        await call("hr_self_onboarding_document_upload", { title: "CNIC", category: "IDENTITY", fileName: "a.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0=" });
        expect(uploadMyDocument).toHaveBeenCalledWith({ tenantId: TENANT, employeeId: 101, title: "CNIC", category: "IDENTITY", fileName: "a.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0=" });
        await call("hr_self_onboarding_task_complete", { taskId: "5" });
        expect(completeMyTask).toHaveBeenCalledWith({ tenantId: TENANT, employeeId: 101, taskId: "5" });
        await call("hr_self_onboarding_document_sign", { documentId: 7 });
        expect(signMyDocument).toHaveBeenCalledWith({ tenantId: TENANT, employeeId: 101, documentId: 7 });
        await call("hr_self_onboarding_survey_submit", { type: "DAY_60", responses: { q: "yes" } });
        expect(submitMySurvey).toHaveBeenCalledWith({ tenantId: TENANT, employeeId: 101, type: "DAY_60", responses: { q: "yes" } });
    });
});

describe("HR side", () => {
    it.each(HR_TOOLS)("%s needs hr:onboarding %s", async (name, action, args, service) => {
        const selfOnly = await call(name, args);
        expect(parse(selfOnly).status).toBe(403);
        const wrong = await call(name, args, { permissions: { "hr:onboarding": [action === "VIEW" ? "EDIT" : "VIEW"] } });
        expect(parse(wrong).status).toBe(403);
        const ok = await call(name, args, { permissions: { "hr:onboarding": [action] } });
        expect(ok.isError).toBeUndefined();
        expect(service).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
    });

    it.each(HR_TOOLS)("%s answers 503 while the flag is off", async (name, action, args, service) => {
        flag.on = false;
        const res = await call(name, args, { permissions: { "hr:onboarding": [action] } });
        expect(parse(res).status).toBe(503);
        expect(service).not.toHaveBeenCalled();
    });

    it("the review carries the reviewer from the claim", async () => {
        await call("hr_onboarding_document_review", { documentId: 7, decision: "REJECTED", note: "Blurry" }, { user: { ...HIRE, employeeId: 55 }, permissions: { "hr:onboarding": ["EDIT"] } });
        expect(reviewOnboardingDocument).toHaveBeenCalledWith({ tenantId: TENANT, reviewerId: 55, documentId: 7, decision: "REJECTED", note: "Blurry" });
    });
});

describe("resolveSelfEmployeeId", () => {
    it("pins to the claim", () => {
        expect(resolveSelfEmployeeId({ employeeId: "101" })).toBe(101);
        expect(resolveSelfEmployeeId({ employeeId: 101 }, 101)).toBe(101);
        expect(() => resolveSelfEmployeeId({ employeeId: 101 }, 5)).toThrow(expect.objectContaining({ status: 403 }));
        expect(() => resolveSelfEmployeeId({ employeeId: null }, 5)).toThrow(expect.objectContaining({ status: 403 }));
        expect(() => resolveSelfEmployeeId({ employeeId: 0 })).toThrow(expect.objectContaining({ status: 400 }));
    });
});
