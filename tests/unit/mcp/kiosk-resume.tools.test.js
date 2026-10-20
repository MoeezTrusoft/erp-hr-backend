// tests/unit/mcp/kiosk-resume.tools.test.js
//
// Recruitment Phase 6 (stream C) — hr_test_session_resume_code_issue: 503
// with either flag off (before the permission), PUT on hr:recruitment, the
// reception capability, and the caller as the actor.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const issueKioskResumeCode = jest.fn(async () => ({ sessionId: 1, code: "123456", resumeNo: 1 }));
jest.unstable_mockModule("../../../src/services/reception.service.js", () => ({ issueKioskResumeCode }));

const { registerKioskResumeTools } = await import("../../../src/mcp/tools/kiosk-resume.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const ALL = ["hr.recruitment.read", "hr.recruitment.create", "hr.recruitment.update", "hr.recruitment.delete"];
const tools = new Map();
registerKioskResumeTools({ tool: (name, _desc, _schema, handler) => tools.set(name, handler) });

async function call(user, args = {}, permissions = ALL) {
    const out = await mcpCtx.run({ user: { tenantId: TENANT, ...user }, permissions }, async () => await tools.get("hr_test_session_resume_code_issue")(args));
    return { isError: out.isError === true, body: JSON.parse(out.content[0].text) };
}
const RECEPTION = { roles: ["RECEPTION"], employeeId: 50 };
const PANELIST = { roles: ["INTERVIEWER"], employeeId: 3 };
const ARGS = { sessionId: 1, workstationId: 81, siteRef: "Lahore", reason: "Kiosk froze" };

beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
    process.env.HR_RECRUITMENT_KIOSK_RESUME = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
    delete process.env.HR_RECRUITMENT_KIOSK_RESUME;
});

describe("hr_test_session_resume_code_issue", () => {
    it("registers one tool and passes reception's call through with the actor", async () => {
        expect([...tools.keys()]).toEqual(["hr_test_session_resume_code_issue"]);
        const out = await call(RECEPTION, ARGS);
        expect(out).toMatchObject({ isError: false, body: { code: "123456" } });
        expect(issueKioskResumeCode).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, actorId: 50, sessionId: 1, workstationId: 81, siteRef: "Lahore", reason: "Kiosk froze" }));
    });

    it("answers 503 with either flag off, before anything else", async () => {
        delete process.env.HR_RECRUITMENT_KIOSK_RESUME;
        expect((await call(RECEPTION, ARGS, [])).body).toMatchObject({ status: 503 });
        process.env.HR_RECRUITMENT_KIOSK_RESUME = "true";
        delete process.env.HR_RECRUITMENT_ONSITE_TEST;
        expect((await call(RECEPTION, ARGS)).body).toMatchObject({ status: 503 });
        expect(issueKioskResumeCode).not.toHaveBeenCalled();
    });

    it("needs PUT and the reception capability", async () => {
        expect((await call(RECEPTION, ARGS, ["hr.recruitment.read"])).body.status).toBe(403);
        expect((await call(PANELIST, ARGS)).body.status).toBe(403);
        expect(issueKioskResumeCode).not.toHaveBeenCalled();
    });
});
