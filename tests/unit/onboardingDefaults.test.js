// tests/unit/onboardingDefaults.test.js
//
// The default onboarding baseline is task POLICY, so it is pinned here: valid
// enum values, hire-date-relative due dates, and stable ordering.
import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_ONBOARDING_TASKS,
  buildOnboardingTaskRows,
} from "../../src/lib/onboardingDefaults.js";

const STAGES = new Set(["pre_joining", "pre_boarding", "first_week", "equipment"]);
const CATEGORIES = new Set([
  "IT_ACCESS_SETUP",
  "WORKSPACE_EQUIPMENT",
  "ORIENTATION_TRAINING",
  "HR_DOCUMENTATION",
  "TEAM_INTRODUCTION",
  "COMPLIANCE_POLICY",
  "OTHER",
]);
const ASSIGNEES = new Set(["HR", "MANAGER", "NEW_HIRE", "IT"]);

describe("Default onboarding task baseline", () => {
  it("uses only valid stage, category and assignee values", () => {
    for (const task of DEFAULT_ONBOARDING_TASKS) {
      expect(STAGES.has(task.stage)).toBe(true);
      expect(CATEGORIES.has(task.category)).toBe(true);
      expect(ASSIGNEES.has(task.assigneeType)).toBe(true);
      expect(task.title.length).toBeGreaterThan(0);
    }
  });

  it("builds rows with hire-date-relative due dates and stable sort order", () => {
    const hireDate = new Date("2026-10-01T00:00:00Z");
    const rows = buildOnboardingTaskRows({ checklistId: 55, tenantId: "tenant-a", startDate: hireDate });

    expect(rows).toHaveLength(DEFAULT_ONBOARDING_TASKS.length);
    rows.forEach((row, index) => {
      expect(row.checklistId).toBe(55);
      expect(row.tenantId).toBe("tenant-a");
      expect(row.sortOrder).toBe(index);
      expect(row.dueDate).toBeInstanceOf(Date);
    });

    // A pre-joining task lands BEFORE day one; the check-in afterwards.
    const contractTask = rows[DEFAULT_ONBOARDING_TASKS.findIndex((t) => t.dueInDays < 0)];
    expect(contractTask.dueDate.getTime()).toBeLessThan(hireDate.getTime());
    const latest = rows.reduce((max, row) => (row.dueDate > max ? row.dueDate : max), rows[0].dueDate);
    expect(latest.getTime()).toBeGreaterThan(hireDate.getTime());
  });

  it("defaults the due date to now when no start date is supplied", () => {
    const rows = buildOnboardingTaskRows({ checklistId: 1, tenantId: "tenant-a" });
    expect(rows.every((row) => row.dueDate instanceof Date && !Number.isNaN(row.dueDate.getTime()))).toBe(true);
  });
});
