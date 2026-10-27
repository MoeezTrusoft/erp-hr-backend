// tests/unit/interviewScheduling.test.js
//
// Phase 7 / decision record §5.2–5.4 — the scheduling rules:
//
//   * §5.4  the coded reason vocabulary is closed; OTHER demands free-text
//           notes; the vocabulary matches the migration's CHECK exactly
//   * §5.2  availability is evaluated against the leave/schedule rows the
//           caller passes — the overlap semantics exist in ONE place
//   * §5.2a APPROVED leave = HARD block (never overridable);
//           non-working-day = WARNING (overridable with a required reason);
//           an override attempt against a hard block refuses

import { describe, it, expect } from "@jest/globals";

import {
    RESCHEDULE_REASONS,
    CANCEL_REASONS,
    SYSTEM_CANCEL_REASONS,
    LIFECYCLE_EVENTS,
    validateLifecycleReason,
    evaluateInterviewerAvailability,
    leaveOverlapsSlot,
    blockedInterviewers,
    validateConflictOverride,
} from "../../src/lib/interview-scheduling.util.js";

describe("interviewScheduling — §5.4 reason vocabulary", () => {
    it("exposes exactly the decision's suggested set", () => {
        expect(RESCHEDULE_REASONS).toEqual([
            "CANDIDATE_REQUEST",
            "INTERVIEWER_CONFLICT",
            "BUSINESS_REQUEST",
            "TECHNICAL_ISSUE",
            "LOGISTICS_ISSUE",
            "REQUISITION_CLOSED",
            "OTHER",
        ]);
    });

    it("accepts every code with or without notes", () => {
        for (const code of RESCHEDULE_REASONS) {
            const r = validateLifecycleReason({ reasonCode: code, notes: null });
            if (code === "OTHER") {
                expect(r.ok).toBe(false); // OTHER without notes refuses
            } else {
                expect(r).toMatchObject({ ok: true, code, notes: null });
            }
        }
    });

    it("demands free-text notes for OTHER — whitespace is not notes", () => {
        expect(validateLifecycleReason({ reasonCode: "OTHER", notes: "   " }).ok).toBe(false);
        expect(validateLifecycleReason({ reasonCode: "OTHER" }).ok).toBe(false);
        expect(validateLifecycleReason({ reasonCode: "OTHER", notes: "Panel lead on flight back" })).toMatchObject({
            ok: true,
            code: "OTHER",
            notes: "Panel lead on flight back",
        });
    });

    it("refuses unknown codes and missing codes", () => {
        expect(validateLifecycleReason({ reasonCode: "JUST_BECAUSE" }).ok).toBe(false);
        expect(validateLifecycleReason({}).ok).toBe(false);
        expect(validateLifecycleReason({ reasonCode: null }).ok).toBe(false);
    });

    it("trims notes and keeps them null when empty", () => {
        expect(validateLifecycleReason({ reasonCode: "TECHNICAL_ISSUE", notes: "  VC bridge down  " }).notes).toBe(
            "VC bridge down",
        );
        expect(validateLifecycleReason({ reasonCode: "TECHNICAL_ISSUE", notes: "   " }).notes).toBeNull();
    });

    it("Phase 3b: a cancel accepts ASSESSMENT_NOT_PASSED, a reschedule does not", () => {
        expect(SYSTEM_CANCEL_REASONS).toEqual(["ASSESSMENT_NOT_PASSED"]);
        expect(CANCEL_REASONS).toEqual([...RESCHEDULE_REASONS, "ASSESSMENT_NOT_PASSED"]);
        expect(RESCHEDULE_REASONS).not.toContain("ASSESSMENT_NOT_PASSED");
        expect(validateLifecycleReason({ reasonCode: "ASSESSMENT_NOT_PASSED" })).toMatchObject({
            ok: true,
            code: "ASSESSMENT_NOT_PASSED",
            notes: null,
        });
        expect(validateLifecycleReason({ reasonCode: "ASSESSMENT_NOT_PASSED", allowed: RESCHEDULE_REASONS }).ok).toBe(false);
        expect(validateLifecycleReason({ reasonCode: "TECHNICAL_ISSUE", allowed: RESCHEDULE_REASONS }).ok).toBe(true);
    });

    it("Phase 3b: every cancel reason is allowed by the lifecycle reason CHECK", async () => {
        const { readFileSync } = await import("node:fs");
        const sql = readFileSync(
            new URL("../../prisma/migrations/20261021003400_recruitment_onsite_assessment/migration.sql", import.meta.url),
            "utf8",
        );
        const check = sql.slice(sql.indexOf('"interview_lifecycle_events_reasoncode_check"\n'));
        for (const code of CANCEL_REASONS) expect(check).toContain(`'${code}'`);
    });

    it("keeps the lifecycle kinds closed", () => {
        expect(LIFECYCLE_EVENTS).toEqual(["CANCELLED", "RESCHEDULED", "RESCHEDULE_REQUESTED"]);
    });
});

describe("interviewScheduling — §5.2 leave overlap", () => {
    const slot = (day, hour = 9) => new Date(2026, 9, day, hour, 0, 0);

    it("a full-day leave on the interview day blocks regardless of hour", () => {
        expect(
            leaveOverlapsSlot(slot(5, 9), new Date(2026, 9, 5, 10, 0), new Date(2026, 9, 5, 0, 0), new Date(2026, 9, 5, 23, 59)),
        ).toBe(true);
    });

    it("leave spanning several days blocks a mid-range slot", () => {
        expect(
            leaveOverlapsSlot(slot(7, 15), new Date(2026, 9, 7, 16, 0), new Date(2026, 9, 6, 0, 0), new Date(2026, 9, 8, 0, 0)),
        ).toBe(true);
    });

    it("adjacent days do not block", () => {
        expect(
            leaveOverlapsSlot(slot(10, 9), new Date(2026, 9, 10, 10, 0), new Date(2026, 9, 9, 0, 0), new Date(2026, 9, 9, 23, 59)),
        ).toBe(false);
    });

    it("blockedInterviewers maps the overlapping rows to ids", () => {
        expect(
            blockedInterviewers(new Date(2026, 9, 5, 9, 0), new Date(2026, 9, 5, 10, 0), [
                { employeeId: 3, startDate: new Date(2026, 9, 5), endDate: new Date(2026, 9, 6) },
                { employeeId: 4, startDate: new Date(2026, 9, 20), endDate: new Date(2026, 9, 21) },
                { employeeId: 5, startDate: new Date(2026, 9, 5), endDate: new Date(2026, 9, 5) },
            ]),
        ).toEqual([3, 5]);
    });
});

describe("interviewScheduling — §5.2a availability tiers", () => {
    it("approved leave is a HARD block carrying its reason", () => {
        const r = evaluateInterviewerAvailability({
            approvedLeave: [{ startDate: "2026-10-05", endDate: "2026-10-06" }],
            isWorkingDay: true,
        });
        expect(r).toMatchObject({ blocked: true, blockReason: "APPROVED_LEAVE" });
    });

    it("a non-working day is a WARNING, not a block", () => {
        const r = evaluateInterviewerAvailability({ approvedLeave: [], isWorkingDay: false });
        expect(r).toMatchObject({ blocked: false, warnings: ["NON_WORKING_DAY"] });
    });

    it("a clean slot is clean", () => {
        expect(evaluateInterviewerAvailability({ approvedLeave: [], isWorkingDay: true })).toMatchObject({
            blocked: false,
            warnings: [],
        });
    });
});

describe("interviewScheduling — §5.2a overrides", () => {
    it("an override against a HARD BLOCK refuses — approved leave is never schedulable", () => {
        expect(
            validateConflictOverride({ hasBlocked: true, override: true, overrideReason: "CEO insists" }).ok,
        ).toBe(false);
    });

    it("a warning-tier override requires a reason — whitespace is not a reason", () => {
        expect(validateConflictOverride({ hasBlocked: false, override: true, overrideReason: "  " }).ok).toBe(false);
        expect(validateConflictOverride({ hasBlocked: false, override: true, overrideReason: undefined }).ok).toBe(false);
        expect(
            validateConflictOverride({ hasBlocked: false, override: true, overrideReason: "Quarter-end panel" }),
        ).toMatchObject({ ok: true, overridden: true, reason: "Quarter-end panel" });
    });

    it("no override needed when there is no conflict", () => {
        expect(validateConflictOverride({ hasBlocked: false, override: false })).toMatchObject({
            ok: true,
            overridden: false,
        });
    });
});
