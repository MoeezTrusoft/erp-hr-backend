// Recruitment Phase 3b (stream I) — the reception and test result MCP
// registrars: the pinned tool names, the flag-off 503, the hr:recruitment
// permission, and the capability split (reception may proctor but not
// decide or extend; recruiters may do both).
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const reception = {
    ID_TYPES: ["CNIC", "PASSPORT", "DRIVING_LICENCE", "OTHER"],
    listArrivals: jest.fn(async () => ({ items: [] })),
    checkInCandidate: jest.fn(async () => ({})),
    issueTestSession: jest.fn(async () => ({})),
    listLiveSessions: jest.fn(async () => ({ items: [] })),
    pauseTestSession: jest.fn(async () => ({})),
    resumeTestSession: jest.fn(async () => ({})),
    voidTestSession: jest.fn(async () => ({})),
    extendTestSession: jest.fn(async () => ({})),
};
const results = {
    decideTestResult: jest.fn(async () => ({ decision: "PROCEED" })),
    getTestAnalytics: jest.fn(async () => ({})),
    getTestResultReport: jest.fn(async () => ({})),
    listTestResults: jest.fn(async () => ({ items: [] })),
    waiveAssessment: jest.fn(async () => ({})),
};
jest.unstable_mockModule("../../../src/services/reception.service.js", () => reception);
jest.unstable_mockModule("../../../src/services/test-result.service.js", () => results);
// The flag check is the real one; the rest of the kiosk service is not needed.
const { isRecruitmentFlagEnabled } = await import("../../../src/lib/recruitment-flags.util.js");
jest.unstable_mockModule("../../../src/services/test-session.service.js", () => ({
    assertOnsiteTestEnabled: () => {
        if (!isRecruitmentFlagEnabled("onsiteTest")) {
            throw Object.assign(new Error("The on-site test is disabled"), { status: 503, code: "HR-RECRUITMENT-ONSITE-TEST-DISABLED" });
        }
    },
}));

const { registerReceptionTools } = await import("../../../src/mcp/tools/reception.tools.js");
const { registerTestResultTools } = await import("../../../src/mcp/tools/test-result.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const ALL = ["hr.recruitment.read", "hr.recruitment.create", "hr.recruitment.update", "hr.recruitment.delete"];

function collect(register) {
    const tools = new Map();
    register({ tool: (name, _desc, _schema, handler) => tools.set(name, handler) });
    return tools;
}
const receptionTools = collect(registerReceptionTools);
const resultTools = collect(registerTestResultTools);

async function call(tools, name, user, args = {}, permissions = ALL) {
    const out = await mcpCtx.run({ user: { tenantId: TENANT, ...user }, permissions }, async () => await tools.get(name)(args));
    return { isError: out.isError === true, body: JSON.parse(out.content[0].text) };
}
const RECEPTION = { roles: ["RECEPTION"], employeeId: 50 };
const RECRUITER = { roles: ["RECRUITER"], employeeId: 1 };
const PANELIST = { roles: ["INTERVIEWER"], employeeId: 3 };

beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_ONSITE_TEST = "true";
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_ONSITE_TEST;
});

describe("reception and test result tools", () => {
    it("registers the pinned names", () => {
        expect([...receptionTools.keys()]).toEqual([
            "hr_reception_arrivals_list", "hr_candidate_checkin", "hr_test_session_issue", "hr_test_sessions_live_list",
            "hr_test_session_pause", "hr_test_session_resume", "hr_test_session_void", "hr_test_session_extend",
        ]);
        expect([...resultTools.keys()]).toEqual([
            "hr_test_result_get", "hr_test_results_list", "hr_test_result_decide", "hr_test_result_waive", "hr_test_analytics_get",
        ]);
    });

    it("answers 503 with the -DISABLED code while the flag is off", async () => {
        process.env.HR_RECRUITMENT_ONSITE_TEST = "false";
        const out = await call(receptionTools, "hr_reception_arrivals_list", RECEPTION, { siteRef: "Lahore" });
        expect(out).toMatchObject({ isError: true, body: { status: 503 } });
        const res = await call(resultTools, "hr_test_result_get", RECRUITER, { resultId: 1 });
        expect(res.body.status).toBe(503);
        expect(reception.listArrivals).not.toHaveBeenCalled();
    });

    it("needs the hr:recruitment grant for the method", async () => {
        const out = await call(receptionTools, "hr_test_session_void", RECEPTION, { sessionId: 1, reason: "x" }, ["hr.recruitment.read"]);
        expect(out).toMatchObject({ isError: true, body: { status: 403 } });
        expect(reception.voidTestSession).not.toHaveBeenCalled();
    });

    it("lets reception proctor but not extend, decide, waive or read analytics", async () => {
        expect((await call(receptionTools, "hr_test_session_pause", RECEPTION, { sessionId: 1, siteRef: "Lahore" })).isError).toBe(false);
        expect(reception.pauseTestSession).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, actorId: 50, sessionId: 1, siteRef: "Lahore" }));
        for (const [tools, name, args] of [
            [receptionTools, "hr_test_session_extend", { sessionId: 1, minutes: 5, reason: "x" }],
            [resultTools, "hr_test_result_decide", { resultId: 1, decision: "RELEASE", reason: "x" }],
            [resultTools, "hr_test_result_waive", { interviewId: 1, reason: "x" }],
            [resultTools, "hr_test_analytics_get", {}],
        ]) {
            const out = await call(tools, name, RECEPTION, args);
            expect(out).toMatchObject({ isError: true, body: { status: 403 } });
        }
        expect(reception.extendTestSession).not.toHaveBeenCalled();
        expect(results.decideTestResult).not.toHaveBeenCalled();
    });

    it("keeps panelists off the reception desk but gives them the report through their scope", async () => {
        expect((await call(receptionTools, "hr_reception_arrivals_list", PANELIST, { siteRef: "Lahore" })).body.status).toBe(403);
        expect((await call(resultTools, "hr_test_result_get", PANELIST, { interviewId: 40 })).isError).toBe(false);
        expect(results.getTestResultReport).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ level: "ASSIGNED", employeeId: 3 }) }));
    });

    it("passes a recruiter's decision through with the actor", async () => {
        const out = await call(resultTools, "hr_test_result_decide", RECRUITER, { resultId: 7, decision: "PROCEED" });
        expect(out.isError).toBe(false);
        expect(results.decideTestResult).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, resultId: 7, decision: "PROCEED", actorId: 1 }));
    });
});
