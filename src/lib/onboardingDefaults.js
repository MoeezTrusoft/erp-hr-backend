// src/lib/onboardingDefaults.js — the DEFAULT onboarding checklist baseline.
//
// A new hire's checklist is seeded with these tasks when the accepted-offer
// handoff provisions the employee (Phase 9). They are a documented BASELINE,
// not a tenant-configurable template: the schema has no template catalogue yet
// (`OnboardingChecklist.template` is a free-text name), so per-tenant template
// authoring remains a later step. Keeping the list in one pure module means the
// handoff service holds no task policy and the baseline is directly testable.
//
// Offsets are in days RELATIVE to the hire date (negative = before day one), the
// same convention HR reads on the onboarding screen.

/**
 * @typedef {object} OnboardingTaskDefault
 * @property {string} title
 * @property {string} description
 * @property {string} stage          pre_joining | pre_boarding | first_week | equipment
 * @property {string} category       OnboardingTaskCategory value
 * @property {string} assigneeType   HR | IT | MANAGER | NEW_HIRE
 * @property {number} dueInDays      days relative to the hire date
 */

/** @type {readonly OnboardingTaskDefault[]} */
export const DEFAULT_ONBOARDING_TASKS = Object.freeze([
    {
        title: "Issue the employment contract for signature",
        description: "Generate the contract from the accepted offer terms and send it for e-signature.",
        stage: "pre_joining",
        category: "HR_DOCUMENTATION",
        assigneeType: "HR",
        dueInDays: -5,
    },
    {
        title: "Verify identity and pre-joining documents",
        description: "Collect and verify CNIC/passport, education certificates and references.",
        stage: "pre_joining",
        category: "HR_DOCUMENTATION",
        assigneeType: "HR",
        dueInDays: -3,
    },
    {
        title: "Prepare work email and system accounts",
        description: "Create the mail account, directory entry and role-based application access.",
        stage: "pre_joining",
        category: "IT_ACCESS_SETUP",
        assigneeType: "IT",
        dueInDays: -2,
    },
    {
        title: "Allocate laptop and peripherals",
        description: "Assign an asset-tagged machine plus any role-specific equipment.",
        stage: "equipment",
        category: "WORKSPACE_EQUIPMENT",
        assigneeType: "IT",
        dueInDays: -1,
    },
    {
        title: "Prepare workspace and access badge",
        description: "Ready the desk and issue a building/office access badge.",
        stage: "equipment",
        category: "WORKSPACE_EQUIPMENT",
        assigneeType: "HR",
        dueInDays: 0,
    },
    {
        title: "Share the employee handbook",
        description: "Send the handbook and code of conduct for acknowledgement.",
        stage: "first_week",
        category: "COMPLIANCE_POLICY",
        assigneeType: "HR",
        dueInDays: 0,
    },
    {
        title: "Complete company orientation",
        description: "Walk through company structure, policies and ways of working.",
        stage: "first_week",
        category: "ORIENTATION_TRAINING",
        assigneeType: "HR",
        dueInDays: 0,
    },
    {
        title: "Introduce the new hire to the team",
        description: "Arrange introductions with the immediate team and key stakeholders.",
        stage: "first_week",
        category: "TEAM_INTRODUCTION",
        assigneeType: "MANAGER",
        dueInDays: 0,
    },
    {
        title: "Confirm day-one system access",
        description: "Verify every required system is reachable with the new credentials.",
        stage: "first_week",
        category: "IT_ACCESS_SETUP",
        assigneeType: "NEW_HIRE",
        dueInDays: 1,
    },
    {
        title: "Collect payroll and tax details",
        description: "Capture bank account and tax identifiers for the payroll assignment.",
        stage: "first_week",
        category: "HR_DOCUMENTATION",
        assigneeType: "HR",
        dueInDays: 2,
    },
    {
        title: "Complete mandatory compliance training",
        description: "Finish the required compliance and security modules.",
        stage: "first_week",
        category: "COMPLIANCE_POLICY",
        assigneeType: "NEW_HIRE",
        dueInDays: 3,
    },
    {
        title: "Schedule the 30-day check-in",
        description: "Book the first review with the reporting manager.",
        stage: "first_week",
        category: "ORIENTATION_TRAINING",
        assigneeType: "MANAGER",
        dueInDays: 30,
    },
]);

const dayOffset = (startDate, days) => {
    const base = startDate ? new Date(startDate) : new Date();
    const due = new Date(base.getTime());
    due.setDate(due.getDate() + days);
    return due;
};

/**
 * Build the `onboarding_tasks` create payload for a new checklist.
 *
 * @param {object} args
 * @param {number} args.checklistId
 * @param {string} args.tenantId
 * @param {Date|string} [args.startDate]  the hire date (offsets are relative to it)
 * @returns {object[]} rows ready for `createMany`
 */
export function buildOnboardingTaskRows({ checklistId, tenantId, startDate }) {
    return DEFAULT_ONBOARDING_TASKS.map((task, index) => ({
        checklistId: Number(checklistId),
        tenantId: tenantId ?? null,
        title: task.title,
        description: task.description,
        stage: task.stage,
        category: task.category,
        assigneeType: task.assigneeType,
        dueDate: dayOffset(startDate, task.dueInDays),
        sortOrder: index,
    }));
}
