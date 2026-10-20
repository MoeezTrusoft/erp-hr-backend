// tests/unit/mcp/recruitment-workspace.tools.test.js
//
// Recruitment Phase 3a — the workspace tools: registration, the GET permission
// on hr:recruitment, and that the caller's resolved scope and tenant reach the
// service.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const workspace = {
    getInterviewerWorkspace: jest.fn(async () => ({ upcoming: { items: [], total: 0 } })),
    getManagerWorkspace: jest.fn(async () => ({ requisitions: { items: [], total: 0 } })),
};
jest.unstable_mockModule("../../../src/services/recruitment-workspace.service.js", () => workspace);

const { registerRecruitmentWorkspaceTools } = await import("../../../src/mcp/tools/recruitment-workspace.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
registerRecruitmentWorkspaceTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });

const TENANT = "11111111-1111-4111-8111-111111111111";
const INTERVIEWER = { userId: "7", roles: ["INTERVIEWER"], isAdmin: false, employeeId: 7, tenantId: TENANT };
const RECRUITER = { userId: "1", roles: ["RECRUITER"], isAdmin: false, employeeId: 1, tenantId: TENANT };
const VIEW = { "hr:recruitment": ["VIEW"] };

const call = (name, args, { user = INTERVIEWER, permissions = VIEW } = {}) =>
    mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe("recruitment workspace tools", () => {
    it("registers both tools under recruitment-area names", () => {
        expect([...handlers.keys()]).toEqual(["hr_interview_workspace_get", "hr_requisition_manager_workspace_get"]);
    });

    it("the interviewer workspace needs VIEW and passes the caller's scope", async () => {
        const res = await call("hr_interview_workspace_get", { limit: 10 });
        expect(res.isError).toBeFalsy();
        expect(workspace.getInterviewerWorkspace).toHaveBeenCalledWith({
            tenantId: TENANT,
            scope: expect.objectContaining({ level: "ASSIGNED", employeeId: 7 }),
            limit: 10,
        });
        const denied = await call("hr_interview_workspace_get", {}, { permissions: { "hr:recruitment": ["EDIT"] } });
        expect(denied.isError).toBe(true);
        expect(parse(denied).status).toBe(403);
    });

    it("the manager workspace passes the filters and the scope", async () => {
        await call("hr_requisition_manager_workspace_get", { managerEmployeeId: "43", status: "ALL", page: 2, pageSize: 5, listLimit: 3 }, { user: RECRUITER });
        expect(workspace.getManagerWorkspace).toHaveBeenCalledWith({
            tenantId: TENANT,
            scope: expect.objectContaining({ level: "ORG" }),
            managerEmployeeId: 43,
            status: "ALL",
            page: 2,
            pageSize: 5,
            listLimit: 3,
        });
        const denied = await call("hr_requisition_manager_workspace_get", {}, { permissions: {} });
        expect(parse(denied).status).toBe(403);
        expect(workspace.getManagerWorkspace).toHaveBeenCalledTimes(1);
    });
});
