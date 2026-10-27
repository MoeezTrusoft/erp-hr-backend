import { describe, it, expect } from "@jest/globals";

const { validateTemplateTasks, resolveChecklistTasks } =
  await import("../../src/lib/onboardingTemplates.js");
const { DEFAULT_ONBOARDING_TASKS, materializeOnboardingTaskRows } =
  await import("../../src/lib/onboardingDefaults.js");

const goodTask = {
  title: "Provision the laptop",
  description: "IT allocates and images the laptop.",
  stage: "equipment",
  category: "IT_ACCESS_SETUP",
  assigneeType: "IT",
  dueInDays: -2,
};

describe("FR-13 — template rules (pure)", () => {
  it("accepts a well-formed task and trims it", () => {
    const verdict = validateTemplateTasks([
      { ...goodTask, title: "  Provision the laptop  ", description: " " },
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.tasks[0]).toMatchObject({
      title: "Provision the laptop",
      description: null,
      dueInDays: -2,
    });
  });

  it("refuses an empty list, a blank title, an unknown vocabulary value and a non-integer offset", () => {
    expect(validateTemplateTasks([]).ok).toBe(false);
    expect(validateTemplateTasks([{ ...goodTask, title: "  " }]).error).toMatch(
      /title is required/,
    );
    expect(
      validateTemplateTasks([{ ...goodTask, stage: "whenever" }]).error,
    ).toMatch(/stage must be one of/);
    expect(
      validateTemplateTasks([{ ...goodTask, assigneeType: "VENDOR" }]).error,
    ).toMatch(/assigneeType must be one of/);
    expect(
      validateTemplateTasks([{ ...goodTask, dueInDays: 1.5 }]).error,
    ).toMatch(/dueInDays must be an integer/);
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
    const broken = resolveChecklistTasks({
      id: 9,
      tasks: [{ title: "", stage: "nope" }],
    });
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
    expect(rows[0]).toMatchObject({
      checklistId: 11,
      tenantId: "t-1",
      sortOrder: 0,
    });
    expect(new Date(rows[0].dueDate).toISOString().slice(0, 10)).toBe(
      "2026-09-29",
    );
  });
});

describe("strict authoring bounds", () => {
  it("rejects coercion, unknown fields, categories and unbounded dates", () => {
    for (const patch of [
      { dueInDays: null },
      { dueInDays: true },
      { dueInDays: "2" },
      { dueInDays: 366 },
      { dueInDays: -366 },
      { category: "BOGUS" },
      { employeeId: 8 },
      { description: 9 },
    ])
      expect(validateTemplateTasks([{ ...goodTask, ...patch }]).ok).toBe(false);
  });
  it("inactive templates resolve to the baseline", () =>
    expect(
      resolveChecklistTasks({ id: 5, isActive: false, tasks: [goodTask] })
        .source,
    ).toBe("DEFAULT"));
});
