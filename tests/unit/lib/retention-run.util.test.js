// Recruitment Phase 5 (plan 6.9) — the pure rules guarding retention apply.
import { describe, it, expect } from "@jest/globals";
import {
    buildRunRecord,
    canManageRetention,
    capIds,
    decideTenantRunMode,
    readRunCandidates,
    resolveRetentionMode,
    signoffRefusal,
} from "../../../src/lib/retention-run.util.js";

const NOW = new Date("2026-10-20T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const TENANT = "11111111-1111-4111-8111-111111111111";

describe("resolveRetentionMode", () => {
    it("defaults to dry-run and never turns a typo into apply", () => {
        expect(resolveRetentionMode(undefined).resolved).toBe("dry-run");
        expect(resolveRetentionMode("APPLY").resolved).toBe("apply");
        expect(resolveRetentionMode("apply-now")).toEqual({ requested: "apply-now", resolved: "dry-run" });
        expect(resolveRetentionMode("off").resolved).toBe("off");
    });
});

describe("decideTenantRunMode", () => {
    it("applies only when env mode, flag and tenant switch all agree", () => {
        expect(decideTenantRunMode({ envMode: "apply", flagOn: true, tenantApplyEnabled: true })).toBe("APPLY");
        for (const args of [
            { envMode: "dry-run", flagOn: true, tenantApplyEnabled: true },
            { envMode: "apply", flagOn: false, tenantApplyEnabled: true },
            { envMode: "apply", flagOn: true, tenantApplyEnabled: false },
            { envMode: "apply", flagOn: true, tenantApplyEnabled: "true" },
        ]) {
            expect(decideTenantRunMode(args)).toBe("DRY_RUN");
        }
    });
});

describe("buildRunRecord", () => {
    it("records what applyRetention did, with ids, holds and no PII", () => {
        const data = buildRunRecord({
            tenantId: TENANT,
            asOf: NOW,
            intendedMode: "APPLY",
            result: { dryRun: false, anonymized: [4, 4, 5], suspendedByLegalHold: [{ id: 6, email: "x@y.z", legalHoldId: 2 }] },
        });
        expect(data).toMatchObject({ mode: "APPLY", status: "COMPLETED", anonymized: 2, wouldAnonymize: 0, suspendedByLegalHold: 1, error: null });
        expect(data.candidateIds).toEqual({ ids: [4, 5], held: [{ candidateId: 6, legalHoldId: 2 }], truncated: false, limitReached: false });
        expect(JSON.stringify(data)).not.toContain("x@y.z");
    });

    it("records a failure under the intended mode, with a bounded error", () => {
        const data = buildRunRecord({ tenantId: TENANT, asOf: NOW, intendedMode: "DRY_RUN", error: new Error("x".repeat(2000)) });
        expect(data).toMatchObject({ mode: "DRY_RUN", status: "FAILED", wouldAnonymize: 0 });
        expect(data.error.length).toBeLessThanOrEqual(1000);
    });

    it("flags a run that filled its read window (more may be due)", () => {
        const full = buildRunRecord({ tenantId: TENANT, asOf: NOW, intendedMode: "DRY_RUN", limit: 2, result: { dryRun: true, wouldAnonymize: [1], suspendedByLegalHold: [{ id: 2 }] } });
        expect(full.candidateIds.limitReached).toBe(true);
        expect(readRunCandidates(full.candidateIds).limitReached).toBe(true);
    });

    it("caps ids and keeps the count", () => {
        expect(capIds([1, 2, 3, "x", -1, 2], 2)).toEqual({ ids: [1, 2], total: 3, truncated: true });
        expect(readRunCandidates([1, 2])).toMatchObject({ ids: [1, 2], held: [] });
        expect(readRunCandidates(null)).toMatchObject({ ids: [], held: [], truncated: false });
    });
});

describe("signoffRefusal", () => {
    const run = { mode: "DRY_RUN", status: "COMPLETED", createdAt: new Date(NOW.getTime() - DAY), signedOffAt: null };
    it("accepts a recent completed dry-run", () => {
        expect(signoffRefusal(run, { now: NOW })).toBeNull();
        expect(signoffRefusal({ ...run, createdAt: new Date(NOW.getTime() - 7 * DAY) }, { now: NOW })).toBeNull();
    });
    it.each([
        [{ mode: "APPLY" }, "HR-RECRUITMENT-RETENTION-RUN-NOT-DRY-RUN"],
        [{ status: "FAILED" }, "HR-RECRUITMENT-RETENTION-RUN-FAILED"],
        [{ createdAt: new Date(NOW.getTime() - 7 * DAY - 1) }, "HR-RECRUITMENT-RETENTION-RUN-STALE"],
        [{ signedOffAt: NOW }, "HR-RECRUITMENT-RETENTION-RUN-ALREADY-SIGNED-OFF"],
    ])("refuses %o", (over, code) => {
        expect(signoffRefusal({ ...run, ...over }, { now: NOW })?.code).toBe(code);
    });
});

describe("canManageRetention", () => {
    it("is the owner once named, an admin before", () => {
        expect(canManageRetention({ user: { employeeId: 5 }, ownerId: 5 })).toBe(true);
        expect(canManageRetention({ user: { employeeId: 6, isAdmin: true }, ownerId: 5 })).toBe(false);
        expect(canManageRetention({ user: { isAdmin: true }, ownerId: null })).toBe(true);
        expect(canManageRetention({ user: { employeeId: 5 }, ownerId: null })).toBe(false);
    });
});
