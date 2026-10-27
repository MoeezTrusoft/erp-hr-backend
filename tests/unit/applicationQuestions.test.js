// tests/unit/applicationQuestions.test.js
//
// Phase 5 / decision record §3.5 — the pure question module and the CRUD rules
// that make a stored answer trustworthy:
//
//   * definition validation (types, options, weights, maxScore derivation)
//   * answer validation + DETERMINISTIC scoring (the same (question, answer)
//     pair always awards the same points, computed once at submission)
//   * versioning: a question with answers is immutable; one without edits free
//   * deactivation: soft when history exists, hard delete when it doesn't
//   * the portal intake validates, scores and stores; unknown answer keys and
//     missing required answers refuse the whole submission

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// ── mocks ────────────────────────────────────────────────────────────────────
const prisma = {
  jobRequisition: { findFirst: jest.fn() },
  applicationQuestion: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    updateMany: jest.fn(),
    aggregate: jest.fn(),
  },
  applicationAnswer: { createMany: jest.fn() },
  applicationStageHistory: { create: jest.fn() },
  candidate: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  candidateConsent: { create: jest.fn() },
  application: { findFirst: jest.fn(), create: jest.fn() },
  $queryRawUnsafe: jest.fn(async () => []),
  $executeRaw: jest.fn(async () => 1),
  candidateDncEntry: { findFirst: jest.fn(async () => null) },
  candidateEmailVerification: {
    updateMany: jest.fn(async () => ({ count: 0 })),
    create: jest.fn(async () => ({ id: 1 })),
  },
  $transaction: jest.fn(),
};
const logAction = jest.fn();
const enqueueHrDomainEvent = jest.fn();
const applicationCreatedEvent = jest.fn(() => ({}));

jest.unstable_mockModule("../../src/config/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: prisma,
}));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));
jest.unstable_mockModule("../../src/lib/portalPolicy.js", () => ({
  portalPolicy: () => ({
    version: "v3",
    url: "https://example.invalid/privacy",
  }),
}));
jest.unstable_mockModule(
  "../../src/services/candidateMailboxQueue.service.js",
  () => ({ queueMailboxMessage: jest.fn(async () => ({ queued: true })) }),
);
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent,
}));
jest.unstable_mockModule("../../src/services/hrEvents.js", () => ({
  applicationCreatedEvent,
  applicationStageChangedEvent: jest.fn(() => ({})),
}));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: (client, fn) => fn(client),
}));

const {
  validateQuestionDefinition,
  validateAnswer,
  validateQuestionSet,
  totalScore,
} = await import("../../src/lib/applicationQuestions.js");
const questionService =
  await import("../../src/services/applicationQuestion.service.js");
const { submitPublicApplication } =
  await import("../../src/services/publicPortal.service.js");

// Silence the audit-log writes; the intake calls it inside the (mocked) tx.
logAction.mockResolvedValue(undefined);

const baseQuestion = {
  id: 1,
  requisitionId: 42,
  tenantId: "t-1",
  type: "SINGLE_CHOICE",
  prompt: "Years of TypeScript?",
  required: false,
  options: [
    { value: "junior", label: "0-2" },
    { value: "mid", label: "3-5" },
    { value: "senior", label: "6+" },
  ],
  weights: { junior: 0, mid: 2, senior: 4 },
  maxScore: 4,
  isActive: true,
  orderIndex: 0,
  version: 1,
};

// ── definition validation ────────────────────────────────────────────────────
describe("applicationQuestions.validateQuestionDefinition", () => {
  it("accepts a valid scored choice question and derives maxScore from the weights", () => {
    const r = validateQuestionDefinition({
      type: "SINGLE_CHOICE",
      prompt: "Rate your SQL",
      required: true,
      options: [
        { value: "a", label: "Basic" },
        { value: "b", label: "Fluent" },
      ],
      weights: { a: 1, b: 3 },
    });
    expect(r.ok).toBe(true);
    expect(r.normalized.maxScore).toBe(4);
    expect(r.normalized.options).toEqual([
      { value: "a", label: "Basic" },
      { value: "b", label: "Fluent" },
    ]);
  });

  it("rejects an unknown type and an empty prompt", () => {
    const r = validateQuestionDefinition({ type: "MAGIC", prompt: "" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/type must be one of/);
    expect(r.errors.join(" ")).toMatch(/prompt is required/);
  });

  it("requires at least two options for choice questions", () => {
    const r = validateQuestionDefinition({
      type: "MULTI_CHOICE",
      prompt: "Pick stacks",
      options: [{ value: "x", label: "X" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/at least 2 options/);
  });

  it("drops duplicate option values so they cannot be double-scored", () => {
    const r = validateQuestionDefinition({
      type: "MULTI_CHOICE",
      prompt: "Pick stacks",
      options: [
        { value: "x", label: "X" },
        { value: "x", label: "X again" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/duplicate option value/);
  });

  it("rejects weights pointing at options that do not exist", () => {
    const r = validateQuestionDefinition({
      type: "SINGLE_CHOICE",
      prompt: "Level?",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      weights: { ghost: 5 },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unknown option "ghost"/);
  });

  it("validates NUMBER bounds and range weights", () => {
    const bad = validateQuestionDefinition({
      type: "NUMBER",
      prompt: "Experience",
      options: { min: 10, max: 2 },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toMatch(
      /options\.min must be <= options\.max/,
    );

    const good = validateQuestionDefinition({
      type: "NUMBER",
      prompt: "Experience",
      options: { min: 0, max: 40 },
      weights: { min: 5, max: 10, points: 3 },
    });
    expect(good.ok).toBe(true);
    expect(good.normalized.maxScore).toBe(3);
  });

  it("rejects weights on free-text questions", () => {
    const r = validateQuestionDefinition({
      type: "TEXT_LONG",
      prompt: "Why here?",
      weights: { yes: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/weights are not supported/);
  });

  it("rejects non-numeric and negative weight points", () => {
    const r = validateQuestionDefinition({
      type: "BOOLEAN",
      prompt: "Authorized to work?",
      weights: { true: "lots", false: -1 },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/must be a number >= 0/);
  });

  it("rejects DATE weight keys that are not ISO dates", () => {
    const r = validateQuestionDefinition({
      type: "DATE",
      prompt: "Earliest start?",
      weights: { tomorrow: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/must be YYYY-MM-DD/);
  });

  it("flags duplicate prompts across a set", () => {
    const r = validateQuestionSet([
      { type: "TEXT_SHORT", prompt: "Notice period?" },
      { type: "NUMBER", prompt: "notice period?" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/duplicate question prompt/);
  });
});

// ── answer validation + deterministic scoring ────────────────────────────────
describe("applicationQuestions.validateAnswer", () => {
  it("scores a single choice deterministically", () => {
    const r = validateAnswer(baseQuestion, "senior");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("senior");
    expect(r.score).toBe(4);
  });

  it("sums multi-choice weights over the deduped selection", () => {
    const q = {
      ...baseQuestion,
      type: "MULTI_CHOICE",
      prompt: "Stacks",
      options: [
        { value: "ts", label: "TS" },
        { value: "go", label: "Go" },
        { value: "py", label: "Py" },
      ],
      weights: { ts: 2, go: 1, py: 1 },
      maxScore: 4,
    };
    const r = validateAnswer(q, ["go", "ts", "ts"]);
    expect(r.value).toEqual(["go", "ts"]); // duplicates dropped, not double-scored
    expect(r.score).toBe(3);
  });

  it("awards NUMBER range weights only inside the band", () => {
    const q = {
      type: "NUMBER",
      prompt: "Experience",
      required: false,
      options: { min: 0, max: 40 },
      weights: { min: 5, max: 10, points: 3 },
    };
    expect(validateAnswer(q, 7).score).toBe(3);
    expect(validateAnswer(q, 2).score).toBe(0);
  });

  it("scores BOOLEAN and DATE from their maps", () => {
    const b = validateAnswer(
      {
        type: "BOOLEAN",
        prompt: "Authorized?",
        required: false,
        weights: { true: 5, false: 0 },
      },
      true,
    );
    expect(b.score).toBe(5);

    const d = validateAnswer(
      {
        type: "DATE",
        prompt: "Start?",
        required: false,
        weights: { "2026-10-01": 2 },
      },
      "2026-10-01",
    );
    expect(d.score).toBe(2);
  });

  it("leaves unscored questions with a null score even when answered", () => {
    const q = {
      type: "TEXT_LONG",
      prompt: "Why?",
      required: false,
      weights: null,
    };
    const r = validateAnswer(q, "Because");
    expect(r.ok).toBe(true);
    expect(r.score).toBeNull();
  });

  it("refuses a missing required answer and skips an optional one with null", () => {
    const required = validateAnswer(
      { ...baseQuestion, required: true },
      undefined,
    );
    expect(required.ok).toBe(false);
    expect(required.errors.join(" ")).toMatch(/is required/);

    const optional = validateAnswer({ ...baseQuestion, required: false }, null);
    expect(optional.ok).toBe(true);
    expect(optional.value).toBeNull();
    expect(optional.score).toBeNull();
  });

  it("rejects out-of-vocabulary and malformed answers", () => {
    expect(validateAnswer(baseQuestion, "ghost").ok).toBe(false);
    expect(validateAnswer(baseQuestion, 5).ok).toBe(false);
    expect(
      validateAnswer({ type: "BOOLEAN", prompt: "B?", required: false }, "true")
        .ok,
    ).toBe(false);
    expect(
      validateAnswer(
        { type: "DATE", prompt: "D?", required: false },
        "31-12-2026",
      ).ok,
    ).toBe(false);
    expect(
      validateAnswer({ type: "NUMBER", prompt: "N?", required: false }, "abc")
        .ok,
    ).toBe(false);
  });

  it("enforces NUMBER bounds and TEXT length caps", () => {
    expect(
      validateAnswer(
        {
          ...baseQuestion,
          type: "NUMBER",
          options: { min: 0, max: 5 },
          weights: null,
        },
        9,
      ).ok,
    ).toBe(false);
    expect(
      validateAnswer(
        { ...baseQuestion, type: "TEXT_SHORT", weights: null },
        "x".repeat(501),
      ).ok,
    ).toBe(false);
  });
});

// ── CRUD: versioning rule ────────────────────────────────────────────────────
describe("applicationQuestion.service CRUD", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockResolvedValue([]);
  });

  it("refuses to edit a question that already has answers (409)", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 42,
      status: "POSTED",
    });
    prisma.applicationQuestion.findFirst.mockResolvedValue({
      ...baseQuestion,
      _count: { answers: 7 },
    });
    await expect(
      questionService.updateQuestion(42, "t-1", 1, { prompt: "New?" }),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it("edits a question that has no answers yet", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 42,
      status: "DRAFT",
    });
    prisma.applicationQuestion.findFirst
      .mockResolvedValueOnce({ ...baseQuestion, _count: { answers: 0 } }) // the question
      .mockResolvedValueOnce(null); // duplicate-prompt probe
    prisma.applicationQuestion.update.mockResolvedValue({
      ...baseQuestion,
      prompt: "Revised?",
    });

    const updated = await questionService.updateQuestion(42, "t-1", 1, {
      prompt: "Revised?",
    });
    expect(updated.prompt).toBe("Revised?");
  });

  it("deactivates (soft) a question with answers and deletes one without", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 42,
      status: "POSTED",
    });

    prisma.applicationQuestion.findFirst.mockResolvedValue({
      ...baseQuestion,
      _count: { answers: 3 },
    });
    expect(await questionService.deactivateQuestion(42, "t-1", 1)).toEqual({
      deactivated: true,
      deleted: false,
    });
    expect(prisma.applicationQuestion.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { isActive: false },
    });

    prisma.applicationQuestion.findFirst.mockResolvedValue({
      ...baseQuestion,
      _count: { answers: 0 },
    });
    expect(await questionService.deactivateQuestion(42, "t-1", 1)).toEqual({
      deactivated: false,
      deleted: true,
    });
    expect(prisma.applicationQuestion.delete).toHaveBeenCalledWith({
      where: { id: 1 },
    });
  });

  it("rejects a reorder list that does not exactly cover the active set", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 42,
      status: "DRAFT",
    });
    prisma.applicationQuestion.findMany.mockResolvedValue([
      { id: 1 },
      { id: 2 },
    ]);
    await expect(
      questionService.reorderQuestions(42, "t-1", [1]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      questionService.reorderQuestions(42, "t-1", [1, 2, 3]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses question CRUD on a requisition from another tenant (404)", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue(null);
    await expect(
      questionService.createQuestion(42, "other", baseQuestion),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rejects a definition that fails validation and a duplicate prompt", async () => {
    prisma.jobRequisition.findFirst.mockResolvedValue({
      id: 42,
      status: "DRAFT",
    });
    await expect(
      questionService.createQuestion(42, "t-1", { type: "NOPE", prompt: "x" }),
    ).rejects.toMatchObject({ status: 400 });

    prisma.applicationQuestion.findFirst.mockResolvedValue({ id: 9 });
    await expect(
      questionService.createQuestion(42, "t-1", {
        type: "TEXT_SHORT",
        prompt: "Dup?",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ── portal intake wiring ─────────────────────────────────────────────────────
const requisitionRow = (overrides = {}) => ({
  id: 42,
  tenantId: "t-1",
  status: "POSTED",
  openings: 1,
  closesAt: null,
  autoCloseWhenFilled: false,
  autoClosedAt: null,
  postings: [{ id: 11, isActive: true, channel: "CAREER_SITE" }],
  ...overrides,
});

const seedIntake = ({
  questions = [baseQuestion],
  requisition = requisitionRow(),
  existingCandidate = null,
} = {}) => {
  prisma.jobRequisition.findFirst.mockResolvedValue(requisition);
  prisma.applicationQuestion.findMany.mockResolvedValue(questions);
  prisma.candidate.findFirst
    .mockResolvedValueOnce(existingCandidate) // reconciliation probe
    .mockResolvedValueOnce(null); // reuse probe inside the duplicate check
  prisma.application.findFirst.mockResolvedValue(null);
  prisma.candidate.create.mockResolvedValue({ id: 7 });
  prisma.candidate.update.mockResolvedValue({});
  prisma.application.create.mockResolvedValue({ id: 900 });
  prisma.applicationAnswer.createMany.mockResolvedValue({
    count: questions.length,
  });
  prisma.applicationStageHistory.create.mockResolvedValue({});
  prisma.candidateConsent.create.mockResolvedValue({});
};

const applyBody = (answers) => ({
  firstName: "New",
  lastName: "Candidate",
  email: "new@example.com",
  policyVersion: "v3",
  consent: true,
  ...(answers ? { answers } : {}),
});

describe("publicPortal.submitPublicApplication — §3.5 questions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    logAction.mockResolvedValue(undefined);
  });

  it("validates, scores and stores answers, deterministically", async () => {
    seedIntake();
    const res = await submitPublicApplication({
      tenantId: "t-1",
      requisitionId: 42,
      body: applyBody({ 1: "senior" }),
    });
    expect(res.received).toBe(true);
    expect(prisma.applicationAnswer.createMany).toHaveBeenCalledWith({
      data: [{ applicationId: 900, questionId: 1, value: "senior", score: 4 }],
    });
  });

  it("refuses the whole submission when a required answer is missing", async () => {
    seedIntake({ questions: [{ ...baseQuestion, required: true }] });
    await expect(
      submitPublicApplication({
        tenantId: "t-1",
        requisitionId: 42,
        body: applyBody({}),
      }),
    ).rejects.toMatchObject({ status: 400, code: "HR-PORTAL-ANSWERS-INVALID" });
    expect(prisma.application.create).not.toHaveBeenCalled();
  });

  it("stores a null-valued row for a skipped optional question", async () => {
    seedIntake();
    await submitPublicApplication({
      tenantId: "t-1",
      requisitionId: 42,
      body: applyBody({}),
    });
    const arg = prisma.applicationAnswer.createMany.mock.calls[0][0];
    expect(arg.data).toEqual([
      { applicationId: 900, questionId: 1, value: null, score: null },
    ]);
  });

  it("refuses answers to questions the form no longer asks", async () => {
    seedIntake({ questions: [] });
    await expect(
      submitPublicApplication({
        tenantId: "t-1",
        requisitionId: 42,
        body: applyBody({ 1: "senior" }),
      }),
    ).rejects.toMatchObject({ status: 400, code: "HR-PORTAL-ANSWERS-INVALID" });
  });

  it("refuses an out-of-vocabulary answer", async () => {
    seedIntake();
    await expect(
      submitPublicApplication({
        tenantId: "t-1",
        requisitionId: 42,
        body: applyBody({ 1: "intern" }),
      }),
    ).rejects.toMatchObject({ status: 400, code: "HR-PORTAL-ANSWERS-INVALID" });
  });

  it("keeps an unscored intake writing no answer rows when no questions exist", async () => {
    seedIntake({ questions: [] });
    const res = await submitPublicApplication({
      tenantId: "t-1",
      requisitionId: 42,
      body: applyBody(undefined),
    });
    expect(res.received).toBe(true);
    expect(prisma.applicationAnswer.createMany).not.toHaveBeenCalled();
  });
});

// totalScore is exported for callers that want one sum; the intake stores per-answer.
describe("applicationQuestions.totalScore", () => {
  it("sums awarded points", () => {
    expect(totalScore([{ score: 4 }, { score: 1 }, { score: null }])).toBe(5);
  });
});
