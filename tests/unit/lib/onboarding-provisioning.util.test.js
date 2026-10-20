// Recruitment Phase 4 — the pure provisioning rules: which tasks are requests
// to IT, what kind, when they are due, the status machine and the task sync.
import { describe, it, expect } from "@jest/globals";
import {
    PROVISIONING_KINDS,
    PROVISIONING_STATUSES,
    allowedProvisioningTransitions,
    canTransitionProvisioning,
    isProvisioningOverdue,
    provisioningDueDate,
    provisioningKindFor,
    provisioningTitleFor,
    qualifiesForProvisioning,
    resolveProvisioningActor,
    syncTargetForTask,
} from "../../../src/lib/onboarding-provisioning.util.js";
import { DEFAULT_ONBOARDING_TASKS } from "../../../src/lib/onboardingDefaults.js";

describe("vocabularies match the migration CHECKs", () => {
    it("kinds and statuses", () => {
        expect(PROVISIONING_KINDS).toEqual(["ACCOUNT", "EMAIL", "DEVICE", "ACCESS", "WORKSPACE", "OTHER"]);
        expect(PROVISIONING_STATUSES).toEqual(["REQUESTED", "IN_PROGRESS", "FULFILLED", "REJECTED", "CANCELLED"]);
    });
});

describe("qualifiesForProvisioning", () => {
    it("picks the baseline's IT and workspace tasks that are requests to IT", () => {
        expect(DEFAULT_ONBOARDING_TASKS.filter(qualifiesForProvisioning).map((t) => t.title)).toEqual([
            "Prepare work email and system accounts",
            "Allocate laptop and peripherals",
            "Prepare workspace and access badge",
        ]);
    });

    it("skips other categories, completed tasks and the new hire's own tasks", () => {
        expect(qualifiesForProvisioning({ category: "HR_DOCUMENTATION", assigneeType: "IT" })).toBe(false);
        expect(qualifiesForProvisioning({ category: "IT_ACCESS_SETUP", assigneeType: "IT", completed: true })).toBe(false);
        expect(qualifiesForProvisioning({ category: "IT_ACCESS_SETUP", assigneeType: "NEW_HIRE" })).toBe(false);
        expect(qualifiesForProvisioning({ category: "WORKSPACE_EQUIPMENT", assigneeType: "MANAGER" })).toBe(true);
        expect(qualifiesForProvisioning(null)).toBe(false);
    });
});

describe("provisioningKindFor", () => {
    it.each([
        ["Prepare work email and system accounts", "IT_ACCESS_SETUP", "EMAIL"],
        ["Allocate laptop and peripherals", "WORKSPACE_EQUIPMENT", "DEVICE"],
        ["Prepare workspace and access badge", "WORKSPACE_EQUIPMENT", "WORKSPACE"],
        ["Create the directory account", "IT_ACCESS_SETUP", "ACCOUNT"],
        ["Grant VPN access", "IT_ACCESS_SETUP", "ACCESS"],
        ["Set up the mailbox", "IT_ACCESS_SETUP", "EMAIL"],
        ["Order a monitor", "WORKSPACE_EQUIPMENT", "DEVICE"],
        ["Get things ready", "IT_ACCESS_SETUP", "ACCESS"],
        ["Get things ready", "WORKSPACE_EQUIPMENT", "WORKSPACE"],
        ["Get things ready", "OTHER", "OTHER"],
        ["Install the Office licence", "IT_ACCESS_SETUP", "ACCESS"],
    ])("%s (%s) → %s", (title, category, kind) => {
        expect(provisioningKindFor({ title, category })).toBe(kind);
    });

    it("matches whole words only", () => {
        expect(provisioningKindFor({ title: "Simple setup", category: "WORKSPACE_EQUIPMENT" })).toBe("WORKSPACE");
    });
});

describe("provisioningDueDate and overdue", () => {
    const start = new Date("2026-11-02T00:00:00.000Z");

    it("the task's own due date, else the day before the start date, else none", () => {
        expect(provisioningDueDate({ taskDueDate: "2026-10-30T00:00:00Z", startDate: start }).toISOString()).toBe("2026-10-30T00:00:00.000Z");
        expect(provisioningDueDate({ taskDueDate: null, startDate: start }).toISOString()).toBe("2026-11-01T00:00:00.000Z");
        expect(provisioningDueDate({})).toBeNull();
        expect(provisioningDueDate({ taskDueDate: "garbage", startDate: null })).toBeNull();
    });

    it("overdue means open and past due", () => {
        const now = new Date("2026-11-01T12:00:00Z");
        expect(isProvisioningOverdue({ status: "REQUESTED", dueDate: "2026-11-01T00:00:00Z" }, now)).toBe(true);
        expect(isProvisioningOverdue({ status: "IN_PROGRESS", dueDate: "2026-11-01T00:00:00Z" }, now)).toBe(true);
        expect(isProvisioningOverdue({ status: "FULFILLED", dueDate: "2026-11-01T00:00:00Z" }, now)).toBe(false);
        expect(isProvisioningOverdue({ status: "REQUESTED", dueDate: "2026-11-02T00:00:00Z" }, now)).toBe(false);
        expect(isProvisioningOverdue({ status: "REQUESTED", dueDate: null }, now)).toBe(false);
    });
});

describe("the status machine", () => {
    it("REQUESTED → IN_PROGRESS → FULFILLED | REJECTED (or closed directly); open → CANCELLED", () => {
        expect(allowedProvisioningTransitions("REQUESTED")).toEqual(["IN_PROGRESS", "FULFILLED", "REJECTED", "CANCELLED"]);
        expect(allowedProvisioningTransitions("IN_PROGRESS")).toEqual(["FULFILLED", "REJECTED", "CANCELLED"]);
        for (const closed of ["FULFILLED", "REJECTED", "CANCELLED"]) expect(allowedProvisioningTransitions(closed)).toEqual([]);
        expect(canTransitionProvisioning("REQUESTED", "FULFILLED")).toBe(true);
        expect(canTransitionProvisioning("FULFILLED", "IN_PROGRESS")).toBe(false);
        expect(allowedProvisioningTransitions("BOGUS")).toEqual([]);
    });

    it("the task sync: complete fulfils an open request; reopen undoes only its own fulfilment", () => {
        expect(syncTargetForTask({ status: "REQUESTED" }, true)).toBe("FULFILLED");
        expect(syncTargetForTask({ status: "IN_PROGRESS" }, true)).toBe("FULFILLED");
        expect(syncTargetForTask({ status: "REJECTED" }, true)).toBeNull();
        expect(syncTargetForTask({ status: "FULFILLED", fulfilledById: null }, false)).toBe("IN_PROGRESS");
        expect(syncTargetForTask({ status: "FULFILLED", fulfilledById: 61 }, false)).toBeNull();
        expect(syncTargetForTask({ status: "IN_PROGRESS" }, false)).toBeNull();
        expect(syncTargetForTask(null, true)).toBeNull();
    });
});

describe("provisioningTitleFor", () => {
    it("trims, defaults and fits the column", () => {
        expect(provisioningTitleFor({ title: "  Laptop  " })).toBe("Laptop");
        expect(provisioningTitleFor({ title: "" })).toBe("Provisioning request");
        expect(provisioningTitleFor({ title: "x".repeat(300) })).toHaveLength(200);
    });
});

describe("resolveProvisioningActor", () => {
    it("an IT-only caller may not cancel; HR, or IT with an HR role, may", () => {
        expect(resolveProvisioningActor({ roles: ["it_support"], employeeId: 61 })).toEqual({ employeeId: 61, itOnly: true, canCancel: false });
        expect(resolveProvisioningActor({ role: "IT" })).toMatchObject({ itOnly: true, canCancel: false, employeeId: null });
        expect(resolveProvisioningActor({ roles: ["IT", "HR_MANAGER"] })).toMatchObject({ itOnly: false, canCancel: true });
        expect(resolveProvisioningActor({ roles: ["HR_ADMIN"], employeeId: "7" })).toEqual({ employeeId: 7, itOnly: false, canCancel: true });
        // A forged isAdmin changes nothing.
        expect(resolveProvisioningActor({ roles: ["IT"], isAdmin: true })).toMatchObject({ canCancel: false });
    });
});
