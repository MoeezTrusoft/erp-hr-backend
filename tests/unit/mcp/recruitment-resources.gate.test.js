// Recruitment and onboarding MCP resources assert the same grant as their list
// tools. Resources are not wrapped by the tool gate, so without these checks
// resources/read returned requisitions, candidates, applications, interviews,
// offers and checklists to any authenticated caller.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const listed = jest.fn(async () => ({ items: [] }));
const recruitmentController = new Proxy(
  {},
  { get: (_, name) => (String(name).startsWith("mcpList") ? listed : jest.fn()) }
);
jest.unstable_mockModule("../../../src/mcp/controllers/recruitmentMcpController.js", () => ({
  ...Object.fromEntries(
    [
      "mcpApproveRequisition", "mcpApproveOffer", "mcpOfferHandoffGet", "mcpOfferHandoffRetry",
      "mcpOfferHandoffsFailedList", "mcpCreateApplication", "mcpCreateCandidate", "mcpCreateInterview",
      "mcpCreateOffer", "mcpCreateRequisition", "mcpAddTalentPool", "mcpDeleteRequisition",
      "mcpListApplications", "mcpListCandidates", "mcpListRecruitmentTags", "mcpListRequisitions",
      "mcpListInterviews", "mcpListOffers", "mcpListTalentPool", "mcpPostRequisition",
      "mcpRemoveTalentPool", "mcpSendOffer", "mcpUpdateApplicationStage", "mcpUpdateApplicationStatus",
      "mcpUpdateCandidate", "mcpUpdateInterview", "mcpUpdateRequisition", "mcpUpdateOffer",
    ].map((name) => [name, recruitmentController[name]])
  ),
}));
jest.unstable_mockModule("../../../src/services/application-question.service.js", () => ({
  listQuestions: listed,
}));
jest.unstable_mockModule("../../../src/mcp/controllers/onboardingMcpController.js", () => ({
  mcpAddOnboardingTask: jest.fn(),
  mcpAssignOnboardingBuddy: jest.fn(),
  mcpCreateOnboardingChecklist: jest.fn(),
  mcpDeleteOnboardingTask: jest.fn(),
  mcpListOnboardingChecklists: listed,
  mcpListOnboardingSurveys: listed,
  mcpSignOnboardingDocument: jest.fn(),
  mcpSubmitOnboardingSurvey: jest.fn(),
  mcpUpdateOnboardingChecklist: jest.fn(),
  mcpUpdateOnboardingTask: jest.fn(),
}));

const { registerRecruitmentTools } = await import("../../../src/mcp/tools/recruitment.tools.js");
const { registerOnboardingTools } = await import("../../../src/mcp/tools/onboarding.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const resources = new Map();
const recording = {
  tool: () => {},
  registerTool: () => {},
  resource: (name, uri, meta, handler) => resources.set(String(uri), handler),
};
registerRecruitmentTools(recording);
registerOnboardingTools(recording);

const USER = { userId: "7", roles: ["RECRUITER"], isAdmin: false, employeeId: "7", tenantId: "tenant-A" };
const read = (uri, permissions) =>
  mcpCtx.run({ user: USER, permissions }, () => resources.get(uri)(new URL(uri.replace("{id}", "9")), { id: "9" }));

const GATED = [
  ["hr://recruitment/requisitions", "hr:recruitment"],
  ["hr://recruitment/requisitions/{id}/public-form", "hr:recruitment"],
  ["hr://recruitment/candidates", "hr:recruitment"],
  ["hr://recruitment/applications", "hr:recruitment"],
  ["hr://recruitment/talent-pool", "hr:recruitment"],
  ["hr://recruitment/tags", "hr:recruitment"],
  ["hr://recruitment/interviews", "hr:recruitment"],
  ["hr://recruitment/offers", "hr:recruitment"],
  ["hr://onboarding/checklists", "hr:onboarding"],
];

beforeEach(() => listed.mockClear());

describe("recruitment and onboarding resources are gated", () => {
  it("covers every recruitment and onboarding resource except the self-service surveys", () => {
    expect([...resources.keys()].sort()).toEqual(
      [...GATED.map(([uri]) => uri), "hr://onboarding/surveys"].sort()
    );
  });

  it.each(GATED)("%s refuses a session without %s and reads nothing", async (uri) => {
    await expect(read(uri, {})).rejects.toMatchObject({ status: 403 });
    expect(listed).not.toHaveBeenCalled();
  });

  it.each(GATED)("%s serves a session holding %s VIEW", async (uri, key) => {
    const result = await read(uri, { [key]: ["VIEW"] });
    expect(result.contents[0].mimeType).toBe("application/json");
    expect(listed).toHaveBeenCalledTimes(1);
  });

  it("does not let a recruitment grant read onboarding checklists", async () => {
    await expect(read("hr://onboarding/checklists", { "hr:recruitment": ["VIEW"] })).rejects.toMatchObject({ status: 403 });
  });
});
