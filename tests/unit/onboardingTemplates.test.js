// tests/unit/onboardingTemplates.test.js
//
// FR-13 residue — tenant-configurable onboarding checklist templates:
//   * the PURE template rules: a closed stage/assignee vocabulary, an integer
//     hire-date offset (never coerced), and an empty list refused (an empty
//     template is not how a tenant says "use the default")
//   * resolution: a tenant template wins; no template / an inactive one / a
//     stored-but-invalid one falls back to the baseline — provisioning never
//     produces an empty checklist because of a configuration change
//   * the SERVICE: upsert validates before storing, exactly one default per
//     tenant, and the first template a tenant creates becomes the default
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const prisma = {
  onboardingChecklistTemplate: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({ tenantTransaction: (c, fn, o) => fn(c, o) }));

const { validateTemplateTasks, resolveChecklistTasks } = await import("../../src/lib/onboarding-templates.util.js");
const { DEFAULT_ONBOARDING_TASKS, materializeOnboardingTaskRows } = await import("../../src/lib/onboarding-defaults.util.js");
const templates = await import("../../src/services/onboarding-template.service.js");

const goodTask = {
  title: "Provision the laptop",
  description: "IT allocates and images the laptop.",
  stage: "equipment",
  category: "IT_ACCESS_SETUP",
  assigneeType: "IT",
  dueInDays: -2,
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.onboardingChecklistTemplate.count.mockResolvedValue(0);
});

describe("FR-13 — template rules (pure)", () => {
  it("accepts a well-formed task and trims it", () => {
    const verdict = validateTemplateTasks([{ ...goodTask, title: "  Provision the laptop  ", description: " " }]);
    expect(verdict.ok).toBe(true);
    expect(verdict.tasks[0]).toMatchObject({ title: "Provision the laptop", description: null, dueInDays: -2 });
  });

  it("refuses an empty list, a blank title, an unknown vocabulary value and a non-integer offset", () => {
    expect(validateTemplateTasks([]).ok).toBe(false);
    expect(validateTemplateTasks([{ ...goodTask, title: "  " }]).error).toMatch(/title is required/);
    expect(validateTemplateTasks([{ ...goodTask, stage: "whenever" }]).error).toMatch(/stage must be one of/);
    expect(validateTemplateTasks([{ ...goodTask, assigneeType: "VENDOR" }]).error).toMatch(/assigneeType must be one of/);
    expect(validateTemplateTasks([{ ...goodTask, dueInDays: 1.5 }]).error).toMatch(/dueInDays must be an integer/);
  });

  it("resolves a tenant template when present and the BASELINE otherwise", () => {
    const fromTemplate = resolveChecklistTasks({ id: 4, tasks: [goodTask] });
    expect(fromTemplate).toMatchObject({ source: "TEMPLATE", templateId: 4 });
    expect(fromTemplate.tasks[0].title).toBe("Provision the laptop");

    const noTemplate = resolveChecklistTasks(null);
    expect(noTemplate.source).toBe("DEFAULT");
    expect(noTemplate.tasks).toBe(DEFAULT_ONBOARDING_TASKS);
  });

  it("a stored-but-invalid template falls back to the baseline rather than an empty checklist", () => {
    const broken = resolveChecklistTasks({ id: 9, tasks: [{ title: "", stage: "nope" }] });
    expect(broken).toMatchObject({ source: "DEFAULT", templateId: null });
    expect(broken.tasks.length).toBe(DEFAULT_ONBOARDING_TASKS.length);
  });

  it("materializes template tasks into rows with the same due-date arithmetic as the baseline", () => {
    const rows = materializeOnboardingTaskRows({
      tasks: [goodTask],
      checklistId: 11,
      tenantId: "t-1",
      startDate: new Date("2026-10-01T00:00:00Z"),
    });
    expect(rows[0]).toMatchObject({ checklistId: 11, tenantId: "t-1", sortOrder: 0 });
    expect(new Date(rows[0].dueDate).toISOString().slice(0, 10)).toBe("2026-09-29");
  });
});

describe("FR-13 — the service", () => {
  it("validates BEFORE storing: an invalid task list never reaches the database", async () => {
    await expect(
      templates.upsertTemplate({ tenantId: "t-1", name: "Standard", tasks: [{ ...goodTask, dueInDays: 1.5 }] })
    ).rejects.toMatchObject({ status: 422, code: "HR-ONBOARDING-TEMPLATE-INVALID" });
    expect(prisma.onboardingChecklistTemplate.create).not.toHaveBeenCalled();
    expect(prisma.onboardingChecklistTemplate.update).not.toHaveBeenCalled();
  });

  it("requires a name and a tenant", async () => {
    await expect(templates.upsertTemplate({ tenantId: "t-1", name: "  ", tasks: [goodTask] })).rejects.toMatchObject({
      code: "HR-ONBOARDING-TEMPLATE-NAME-REQUIRED",
    });
    await expect(templates.upsertTemplate({ name: "X", tasks: [goodTask] })).rejects.toMatchObject({ status: 400 });
  });

  it("promoting a default CLEARS the incumbent in the same transaction (exactly one default)", async () => {
    prisma.onboardingChecklistTemplate.findFirst.mockResolvedValue(null);
    prisma.onboardingChecklistTemplate.create.mockResolvedValue({ id: 1 });
    await templates.upsertTemplate({ tenantId: "t-1", name: "Standard", tasks: [goodTask], makeDefault: true });
    expect(prisma.onboardingChecklistTemplate.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ isDefault: true }),
      data: { isDefault: false },
    });
  });

  it("the FIRST template a tenant creates becomes the default without being asked to", async () => {
    prisma.onboardingChecklistTemplate.count.mockResolvedValue(0);
    prisma.onboardingChecklistTemplate.findFirst.mockResolvedValue(null);
    prisma.onboardingChecklistTemplate.create.mockResolvedValue({ id: 1 });
    await templates.upsertTemplate({ tenantId: "t-1", name: "Standard", tasks: [goodTask] });
    expect(prisma.onboardingChecklistTemplate.create.mock.calls[0][0].data.isDefault).toBe(true);
  });

  it("an update to an existing template is an update, not a duplicate", async () => {
    prisma.onboardingChecklistTemplate.findFirst.mockResolvedValue({ id: 7 });
    prisma.onboardingChecklistTemplate.update.mockResolvedValue({ id: 7 });
    await templates.upsertTemplate({ tenantId: "t-1", name: "Standard", tasks: [goodTask] });
    expect(prisma.onboardingChecklistTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } })
    );
    expect(prisma.onboardingChecklistTemplate.create).not.toHaveBeenCalled();
  });

  it("deactivating a template clears its default flag (tenant falls back to the baseline)", async () => {
    prisma.onboardingChecklistTemplate.findFirst.mockResolvedValue({ id: 7 });
    prisma.onboardingChecklistTemplate.update.mockResolvedValue({ id: 7, isActive: false, isDefault: false });
    await templates.deactivateTemplate({ tenantId: "t-1", templateId: 7 });
    expect(prisma.onboardingChecklistTemplate.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { isActive: false, isDefault: false },
    });
  });

  it("a cross-tenant template id reads as NOT FOUND, not forbidden", async () => {
    prisma.onboardingChecklistTemplate.findFirst.mockResolvedValue(null);
    await expect(templates.deactivateTemplate({ tenantId: "t-1", templateId: 99 })).rejects.toMatchObject({
      status: 404,
      code: "HR-ONBOARDING-TEMPLATE-NOT-FOUND",
    });
  });
});
