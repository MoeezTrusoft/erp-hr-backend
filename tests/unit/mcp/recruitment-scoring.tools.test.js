// tests/unit/mcp/recruitment-scoring.tools.test.js
//
// Recruitment Phase 2 (§6.4) — the scoring tools: registration, the 503 when
// HR_RECRUITMENT_SCORING is off, the permission method each tool asks for, and
// that the caller's resolved scope reaches the service. Also checks that the
// shortlist add/remove tools now pass the scope through.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const scoring = {
    getApplicationScore: jest.fn(async () => ({ applicationId: 900, score: 81, band: "STRONG", components: [] })),
    listRequisitionRanking: jest.fn(async () => ({ items: [{ rank: 1, applicationId: 900 }], total: 1, page: 1, pageSize: 25 })),
    proposeShortlist: jest.fn(async () => ({ requisitionId: 12, proposed: [900] })),
    confirmShortlistProposal: jest.fn(async () => ({ applicationId: 900, confirmed: true })),
    dismissShortlistProposal: jest.fn(async () => ({ applicationId: 900, dismissed: true })),
};
const screening = {
    recordScreening: jest.fn(),
    listScreenings: jest.fn(),
    listDispositionReasons: jest.fn(),
    versionDispositionReason: jest.fn(),
    deactivateDispositionReason: jest.fn(),
    addToShortlist: jest.fn(async () => ({ id: 1 })),
    listShortlist: jest.fn(async () => []),
    removeFromShortlist: jest.fn(async () => ({ removed: true })),
};

jest.unstable_mockModule("../../../src/services/application-scoring.service.js", async () => {
    const { isRecruitmentFlagEnabled } = await import("../../../src/lib/recruitmentFlags.js");
    return {
        ...scoring,
        assertScoringEnabled: () => {
            if (!isRecruitmentFlagEnabled("scoring")) {
                throw Object.assign(new Error("Application scoring is disabled"), { status: 503, code: "HR-RECRUITMENT-SCORING-DISABLED" });
            }
        },
    };
});
jest.unstable_mockModule("../../../src/services/applicationScreening.service.js", () => screening);
jest.unstable_mockModule("../../../src/services/applicationService.js", () => ({
    listApplications: jest.fn(),
    getApplication: jest.fn(),
    deleteApplication: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/interviewPacket.service.js", () => ({
    addPacketItem: jest.fn(),
    listPacket: jest.fn(),
    removePacketItem: jest.fn(),
    getPacketForViewer: jest.fn(),
}));

const { registerRecruitmentScoringTools } = await import("../../../src/mcp/tools/recruitment-scoring.tools.js");
const { registerApplicationTools } = await import("../../../src/mcp/tools/applicationTools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const handlers = new Map();
const recording = { tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]), resource: () => {} };
registerRecruitmentScoringTools(recording);
const scoringTools = [...handlers.keys()];
registerApplicationTools(recording);

const TENANT = "11111111-1111-4111-8111-111111111111";
const MANAGER = { userId: "42", roles: ["HIRING_MANAGER"], isAdmin: false, employeeId: 42, tenantId: TENANT };
const ALL = { "hr:recruitment": ["VIEW", "CREATE", "EDIT", "DELETE"] };

const call = (name, args, { user = MANAGER, permissions = ALL } = {}) =>
    mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_SCORING = "true";
});

describe("registration", () => {
    it("registers the scoring tools under recruitment-area names", () => {
        expect(scoringTools).toEqual([
            "hr_application_score_get",
            "hr_requisition_rank_list",
            "hr_requisition_shortlist_propose",
            "hr_application_shortlist_proposal_confirm",
            "hr_application_shortlist_proposal_dismiss",
        ]);
        for (const name of scoringTools) {
            expect(name).toMatch(/^hr_(requisition|candidate|interview|offer|talent|recruitment|application|pipeline)/);
        }
    });
});

describe("flag off", () => {
    it.each([
        ["hr_application_score_get", { applicationId: 900 }],
        ["hr_requisition_rank_list", { requisitionId: 12 }],
        ["hr_requisition_shortlist_propose", { requisitionId: 12 }],
        ["hr_application_shortlist_proposal_confirm", { applicationId: 900 }],
        ["hr_application_shortlist_proposal_dismiss", { applicationId: 900 }],
    ])("%s answers 503 while HR_RECRUITMENT_SCORING is off", async (name, args) => {
        delete process.env.HR_RECRUITMENT_SCORING;
        const res = await call(name, args);
        expect(res.isError).toBe(true);
        // The service error carries HR-RECRUITMENT-SCORING-DISABLED; the MCP
        // error map keeps the 503 but reports 5xx codes that are not HR-nnnn
        // as HR-5000 (ERR-3), so the status is what a client sees here.
        expect(parse(res).status).toBe(503);
        for (const fn of Object.values(scoring)) expect(fn).not.toHaveBeenCalled();
    });
});

describe("permission and scope", () => {
    it("score_get needs VIEW and passes the caller's scope", async () => {
        const res = await call("hr_application_score_get", { applicationId: "900" });
        expect(parse(res)).toMatchObject({ applicationId: 900, band: "STRONG" });
        expect(scoring.getApplicationScore).toHaveBeenCalledWith({
            tenantId: TENANT,
            applicationId: "900",
            scope: expect.objectContaining({ level: "MANAGED", employeeId: 42 }),
        });
        const denied = await call("hr_application_score_get", { applicationId: 900 }, { permissions: { "hr:recruitment": ["EDIT"] } });
        expect(denied.isError).toBe(true);
        expect(parse(denied).status).toBe(403);
    });

    it("rank_list returns the standard list envelope", async () => {
        const res = await call("hr_requisition_rank_list", { requisitionId: 12, page: 1, pageSize: 25 });
        expect(parse(res)).toMatchObject({ items: [{ rank: 1 }], total: 1, sort: "score", order: "desc", filters: { requisitionId: 12 } });
        expect(scoring.listRequisitionRanking.mock.calls[0][0].scope.level).toBe("MANAGED");
    });

    it("propose needs CREATE (POST) and records the actor", async () => {
        const denied = await call("hr_requisition_shortlist_propose", { requisitionId: 12 }, { permissions: { "hr:recruitment": ["VIEW"] } });
        expect(parse(denied).status).toBe(403);
        await call("hr_requisition_shortlist_propose", { requisitionId: 12 });
        expect(scoring.proposeShortlist).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, requisitionId: 12, actorId: 42 }));
    });

    it("confirm and dismiss need EDIT (PUT) and pass scope and actor", async () => {
        await call("hr_application_shortlist_proposal_confirm", { applicationId: 900 });
        await call("hr_application_shortlist_proposal_dismiss", { applicationId: 900 });
        for (const fn of [scoring.confirmShortlistProposal, scoring.dismissShortlistProposal]) {
            expect(fn).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 900, actorId: 42, scope: expect.objectContaining({ level: "MANAGED" }) }));
        }
    });
});

describe("shortlist add/remove tools carry the scope", () => {
    it("hr_application_shortlist_add and _remove pass the resolved scope", async () => {
        await call("hr_application_shortlist_add", { id: 900 });
        await call("hr_application_shortlist_remove", { id: 900 });
        expect(screening.addToShortlist).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ level: "MANAGED", employeeId: 42 }) }));
        expect(screening.removeFromShortlist).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ level: "MANAGED", employeeId: 42 }) }));
    });
});
