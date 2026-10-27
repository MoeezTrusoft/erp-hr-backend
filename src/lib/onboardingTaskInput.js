import { AppError } from "../utils/AppError.js";
import { ONBOARDING_TASK_CATEGORIES } from "./onboardingTaxonomy.js";
export const ONBOARDING_STAGES = [
  "pre_joining",
  "pre_boarding",
  "first_week",
  "equipment",
];
export function validateOnboardingTask(input, { create = false } = {}) {
  const fail = (message) => {
    throw new AppError(message, 422);
  };
  if (
    input.expectedProvisioningVersion !== undefined &&
    (!Number.isInteger(input.expectedProvisioningVersion) ||
      input.expectedProvisioningVersion < 0)
  )
    fail("Use the current provisioning request version");
  if (create || input.title !== undefined)
    if (
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 200
    )
      fail("Task title must be 1–200 characters");
  if (
    input.description != null &&
    (typeof input.description !== "string" || input.description.length > 4000)
  )
    fail("Task description must be at most 4000 characters");
  if (
    input.category != null &&
    !ONBOARDING_TASK_CATEGORIES.includes(input.category)
  )
    fail("Unknown onboarding category");
  if (input.stage != null && !ONBOARDING_STAGES.includes(input.stage))
    fail("Unknown onboarding stage");
  if (
    input.assigneeType != null &&
    !["HR", "MANAGER", "NEW_HIRE", "IT"].includes(input.assigneeType)
  )
    fail("Unknown assignee type");
  if (input.done !== undefined && typeof input.done !== "boolean")
    fail("Completion must be true or false");
  if (input.deadline != null && input.deadline !== "") {
    const value =
      input.deadline instanceof Date
        ? input.deadline.toISOString()
        : input.deadline;
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) ||
      !Number.isFinite(+new Date(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value.slice(0, 10)
    )
      fail("Use a valid task deadline");
  }
}
