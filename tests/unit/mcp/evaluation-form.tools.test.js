// tests/unit/mcp/evaluation-form.tools.test.js
//
// Recruitment Phase 3b — the evaluation-form tool surface:
//   * the new registrar's tools check hr:recruitment first and answer 503
//     with evaluationForms off;
//   * the extended existing tools take exactly their old inputs with the flag
//     off (hr_interview_score, the template tools) and dispatch as before;
//   * with the flag on, hr_interview_score submits the form when one applies
//     and does not record the outcome, and falls back to the old path when
//     none applies.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const scoreInterview = jest.fn(async () => ({ ok: true }));
const setInterviewOutcome = jest.fn(async () => ({ outcome: true }));
const submitEvaluationScorecard = jest.fn();

jest.unstable_mockModule("../../../src/services/interview-mgmt.service.js", () => ({
  listInterviewsManaged: jest.fn(),
  getInterviewManaged: jest.fn(),
  scoreInterview,
  setInterviewOutcome,
  consolidateInterviewFeedback: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/evaluation-form.service.js", () => ({
  submitEvaluationScorecard,
  getInterviewForm: jest.fn(async () => ({ form: true })),
  saveScorecardDraft: jest.fn(async () => ({ draft: true })),
  draftFormWithAi: jest.fn(async () => ({ ai: true })),
}));
jest.unstable_mockModule("../../../src/services/scorecard-template.service.js", () => ({
  createTemplate: jest.fn(async (args) => ({ created: args })),
  updateTemplate: jest.fn(async (args) => ({ updated: args })),
  deactivateTemplate: jest.fn(),
  listTemplates: jest.fn(),
  linkTemplate: jest.fn(async (args) => args),
  resolveForInterview: jest.fn(async (args) => ({ resolved: args })),
  createFormTemplate: jest.fn(),
  pinEvaluationFormForInterview: jest.fn(),
  FORM_TEMPLATE_SELECT: { id: true },
}));

const { registerInterviewMgmtTools } = await import("../../../src/mcp/tools/interview-mgmt.tools.js");
const { registerEvaluationFormTools } = await import("../../../src/mcp/tools/evaluation-form.tools.js");
const templates = await import("../../../src/services/scorecard-template.service.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const T = "55555555-5555-4555-8555-555555555555";
const USER = { userId: "7", roles: ["RECRUITER"], employeeId: "7", tenantId: T, isAdmin: false };
const GRANT = { "hr:recruitment": ["VIEW", "CREATE", "EDIT", "DELETE"] };

function register(fn) {
  const tools = new Map();
  fn({ tool: (name, description, schema, handler) => tools.set(name, { description, schema, handler }), resource: () => {} });
  return tools;
}
const call = (tools, name, args, { user = USER, permissions = GRANT } = {}) =>
  mcpCtx.run({ user, permissions }, () => tools.get(name).handler(args));
const parse = (res) => JSON.parse(res.content[0].text);

const NEW_TOOLS = [
  ["hr_interview_form_get", { interviewId: 1 }],
  ["hr_interview_scorecard_draft_save", { interviewId: 1 }],
  ["hr_interview_questions_list", {}],
  ["hr_interview_question_create", { competencyKey: "sql", prompt: "p" }],
  ["hr_interview_question_update", { questionId: 1 }],
  ["hr_interview_question_retire", { questionId: 1 }],
  ["hr_interview_form_draft_ai", { requisitionId: 1 }],
  ["hr_interview_evaluation_summary_get", { interviewId: 1 }],
  ["hr_interview_evaluation_export", { interviewId: 1 }],
  ["hr_rater_calibration_get", {}],
];

afterEach(() => {
  delete process.env.HR_RECRUITMENT_EVALUATION_FORMS;
  jest.clearAllMocks();
});

describe("registerEvaluationFormTools", () => {
  const tools = register(registerEvaluationFormTools);

  it("registers the ten Phase 3b tools", () => {
    expect([...tools.keys()].sort()).toEqual(NEW_TOOLS.map(([n]) => n).sort());
  });

  it.each(NEW_TOOLS)("%s: deny-by-default, then 503 with the flag off", async (name, args) => {
    const denied = await call(tools, name, args, { permissions: {} });
    expect(parse(denied).status).toBe(403);
    const off = await call(tools, name, args);
    expect(off.isError).toBe(true);
    expect(parse(off).status).toBe(503);
  });

  it("dispatches with the flag on, and keeps the bank writes for HR and recruiters", async () => {
    process.env.HR_RECRUITMENT_EVALUATION_FORMS = "true";
    expect(parse(await call(tools, "hr_interview_form_get", { interviewId: 1 }))).toEqual({ form: true });
    const panelist = { ...USER, roles: ["INTERVIEWER"], employeeId: "21" };
    const res = await call(tools, "hr_interview_question_create", { competencyKey: "sql", prompt: "p" }, { user: panelist });
    expect(parse(res).status).toBe(403);
  });
});

describe("hr_interview_score with the flag off (unchanged)", () => {
  const tools = register(registerInterviewMgmtTools);
  const args = { interviewId: 5, ratings: { technicalSkills: 4, problemSolving: 4, communication: 4, cultureFit: 4 }, decision: "NEXT_ROUND", recommendation: "HIRE" };

  it("takes exactly the old inputs", () => {
    const { schema } = tools.get("hr_interview_score");
    expect(Object.keys(schema).sort()).toEqual(["amendmentReason", "comments", "decision", "interviewId", "overrideReason", "ratings", "reason", "recommendation", "reviewerId"]);
    expect(schema.ratings.isOptional()).toBe(false);
    expect(schema.recommendation.options).toEqual(["STRONG_HIRE", "HIRE", "HOLD", "REJECTED"]);
    expect(Object.keys(tools.get("hr_scorecard_template_create").schema).sort()).toEqual(["criteria", "description", "name"]);
    expect(tools.get("hr_scorecard_template_link").schema.scopeType.options).toEqual(["REQUISITION", "STAGE", "JOB_FAMILY"]);
    expect(Object.keys(tools.get("hr_scorecard_template_resolve").schema)).toEqual(["interviewId"]);
  });

  it("scores then records the outcome, never touching the form path", async () => {
    const res = await call(tools, "hr_interview_score", args);
    expect(parse(res)).toEqual({ outcome: true });
    expect(submitEvaluationScorecard).not.toHaveBeenCalled();
    expect(scoreInterview).toHaveBeenCalledWith(expect.objectContaining({ interviewId: 5, reviewerId: "7", decision: "NEXT_ROUND", tenantId: T }));
    expect(setInterviewOutcome).toHaveBeenCalledWith(expect.objectContaining({ interviewId: 5, decision: "NEXT_ROUND" }));
  });

  it("template tools pass the old arguments only", async () => {
    await call(tools, "hr_scorecard_template_create", { name: "T", criteria: [{ key: "a" }] });
    expect(templates.createTemplate).toHaveBeenCalledWith({ name: "T", description: null, criteria: [{ key: "a" }], tenantId: T, actorId: "7" });
    await call(tools, "hr_scorecard_template_resolve", { interviewId: 3 });
    expect(templates.resolveForInterview).toHaveBeenCalledWith({ interviewId: 3, tenantId: T });
  });
});

describe("hr_interview_score with the flag on", () => {
  let tools;
  beforeEach(() => {
    process.env.HR_RECRUITMENT_EVALUATION_FORMS = "true";
    tools = register(registerInterviewMgmtTools);
  });

  it("adds the form inputs and relaxes ratings", () => {
    const { schema } = tools.get("hr_interview_score");
    expect(schema).toHaveProperty("criterionScores");
    expect(schema).toHaveProperty("coiDeclared");
    expect(schema.ratings.isOptional()).toBe(true);
    expect(schema.recommendation.options).toEqual(expect.arrayContaining(["NO_HIRE", "STRONG_NO_HIRE", "HOLD"]));
    expect(tools.get("hr_scorecard_template_create").schema).toHaveProperty("sections");
    expect(tools.get("hr_scorecard_template_link").schema.scopeType.options).toEqual(expect.arrayContaining(["INTERVIEW_TYPE", "PANEL_ROLE"]));
  });

  it("submits the form and leaves the outcome to the hiring manager", async () => {
    submitEvaluationScorecard.mockResolvedValue({ handled: true, data: { status: "SUBMITTED", outcomeRecorded: false } });
    const res = await call(tools, "hr_interview_score", { interviewId: 5, decision: "HOLD", recommendation: "NO_HIRE", criterionScores: [{ key: "sql", rating: 3 }], coiDeclared: true });
    expect(parse(res)).toEqual({ status: "SUBMITTED", outcomeRecorded: false });
    expect(submitEvaluationScorecard).toHaveBeenCalledWith(USER, expect.objectContaining({ interviewId: 5, recommendation: "NO_HIRE", coiDeclared: true }));
    expect(scoreInterview).not.toHaveBeenCalled();
    expect(setInterviewOutcome).not.toHaveBeenCalled();
  });

  it("falls back to the old path without a form, which still needs ratings and an old recommendation", async () => {
    submitEvaluationScorecard.mockResolvedValue({ handled: false });
    const noRatings = await call(tools, "hr_interview_score", { interviewId: 5, decision: "HOLD", recommendation: "HIRE" });
    expect(parse(noRatings).status).toBe(400);
    const badRec = await call(tools, "hr_interview_score", { interviewId: 5, decision: "HOLD", recommendation: "NO_HIRE", ratings: { technicalSkills: 3, problemSolving: 3, communication: 3, cultureFit: 3 } });
    expect(parse(badRec).status).toBe(400);
    await call(tools, "hr_interview_score", { interviewId: 5, decision: "HOLD", recommendation: "HIRE", ratings: { technicalSkills: 3, problemSolving: 3, communication: 3, cultureFit: 3 } });
    expect(scoreInterview).toHaveBeenCalledTimes(1);
    expect(setInterviewOutcome).toHaveBeenCalledTimes(1);
  });

  it("form fields on the template tools are for HR and recruiters", async () => {
    const manager = { ...USER, roles: ["HIRING_MANAGER"], employeeId: "30" };
    const res = await call(tools, "hr_scorecard_template_create", { name: "F", sections: [] }, { user: manager });
    expect(parse(res).status).toBe(403);
    await call(tools, "hr_scorecard_template_create", { name: "F", sections: [{ criteria: [] }], status: "DRAFT" });
    expect(templates.createTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: "F", sections: [{ criteria: [] }], status: "DRAFT" }));
  });
});
