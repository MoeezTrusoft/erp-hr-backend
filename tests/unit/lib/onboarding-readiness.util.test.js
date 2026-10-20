// Recruitment Phase 4 (stream M) — the pure day-one readiness and survey
// rules: gap kinds, verdict, the tenant-local window and alert day, routing,
// the 30/60/90 schedule with its grace window, the reminder window, who has
// left, and completion per cohort.
import { describe, it, expect } from "@jest/globals";
import {
    READINESS_GAP_KIND,
    alertedToday,
    cohortMonth,
    computeReadinessGaps,
    countGapsByKind,
    daysUntilStart,
    dueSurveyTypes,
    employeeHasLeft,
    isInReadinessWindow,
    localDayStartUtc,
    readinessVerdict,
    resolveHrOwnerId,
    resolveLeadDays,
    shouldRemindSurvey,
    storedGaps,
    surveyCompletion,
    surveyDueAt,
} from "../../../src/lib/onboarding-readiness.util.js";

const KHI = "Asia/Karachi";
const DAY = 24 * 60 * 60 * 1000;

describe("readiness gaps", () => {
    const inputs = {
        tasks: [
            { id: 1, title: "Collect CNIC copy", stage: "pre_joining", completed: false, dueDate: new Date("2026-10-21T00:00:00Z") },
            { id: 2, title: "Send welcome pack", stage: "pre_boarding", completed: true },
            { id: 3, title: "Team lunch", stage: "first_week", completed: false },
        ],
        provisioningRequests: [
            { id: 10, title: "Laptop", status: "REQUESTED" },
            { id: 11, title: "Email", status: "FULFILLED" },
            { id: 12, title: "VPN", status: "CANCELLED" },
            { id: 13, title: "Badge", status: "REJECTED" },
        ],
        documents: [
            { id: 20, title: "Contract", requiresSign: true, signedAt: null },
            { id: 21, title: "Policy", requiresSign: true, signedAt: new Date() },
            { id: 22, title: "Degree scan", requiresSign: false, reviewStatus: "PENDING" },
            { id: 23, title: "CNIC scan", requiresSign: false, reviewStatus: "VERIFIED" },
        ],
        sessions: [
            { id: 30, title: "Orientation", required: true, sessionDate: null },
            { id: 31, title: "Security briefing", required: true, sessionDate: new Date() },
            { id: 32, title: "Optional meetup", required: false, sessionDate: null },
        ],
    };

    it("finds each kind and nothing else", () => {
        const gaps = computeReadinessGaps(inputs);
        expect(gaps.map((g) => [g.kind, g.id])).toEqual([
            ["TASK", 1],
            ["PROVISIONING", 10],
            ["PROVISIONING", 13],
            ["SIGNATURE", 20],
            ["UPLOAD_REVIEW", 22],
            ["SESSION", 30],
        ]);
        expect(gaps[0]).toEqual({ kind: "TASK", id: 1, title: "Collect CNIC copy", dueDate: "2026-10-21T00:00:00.000Z" });
        expect(countGapsByKind(gaps)).toEqual({ tasks: 1, provisioning: 2, signatures: 1, uploads: 1, sessions: 1 });
        expect(readinessVerdict(gaps)).toBe("AT_RISK");
    });

    it("an empty checklist is READY with zero counts", () => {
        const gaps = computeReadinessGaps({});
        expect(readinessVerdict(gaps)).toBe("READY");
        expect(countGapsByKind(gaps)).toEqual({ tasks: 0, provisioning: 0, signatures: 0, uploads: 0, sessions: 0 });
    });

    it("bounds the stored list", () => {
        const many = Array.from({ length: 150 }, (_, i) => ({ kind: READINESS_GAP_KIND.TASK, id: i }));
        expect(storedGaps(many)).toHaveLength(100);
    });
});

describe("the window and the alert day", () => {
    // 07:00 Karachi on 20 Oct = 02:00 UTC.
    const now = new Date("2026-10-20T02:00:00Z");

    it("counts calendar days from the tenant's today", () => {
        expect(daysUntilStart(new Date("2026-10-20T00:00:00Z"), now, KHI)).toBe(0);
        expect(daysUntilStart(new Date("2026-10-22T00:00:00Z"), now, KHI)).toBe(2);
        expect(daysUntilStart(new Date("2026-10-19T00:00:00Z"), now, KHI)).toBe(-1);
        // 21:00 UTC on 19 Oct is already 20 Oct in Karachi.
        expect(daysUntilStart(new Date("2026-10-21T00:00:00Z"), new Date("2026-10-19T21:00:00Z"), KHI)).toBe(1);
    });

    it("is inside today .. today + lead days", () => {
        const w = (d, leadDays = 2) => isInReadinessWindow({ startDate: new Date(`2026-10-${d}T00:00:00Z`), now, timeZone: KHI, leadDays });
        expect([w(19), w(20), w(21), w(22), w(23)]).toEqual([false, true, true, true, false]);
        expect(w(20, 0)).toBe(true);
        expect(w(21, 0)).toBe(false);
    });

    it("lead days fall back to 2 and cap at 14", () => {
        expect(resolveLeadDays(undefined)).toBe(2);
        expect(resolveLeadDays(-1)).toBe(2);
        expect(resolveLeadDays(5)).toBe(5);
        expect(resolveLeadDays(40)).toBe(14);
    });

    it("alerted today means since the tenant's local midnight", () => {
        expect(localDayStartUtc(now, KHI).toISOString()).toBe("2026-10-19T19:00:00.000Z");
        expect(alertedToday(null, now, KHI)).toBe(false);
        expect(alertedToday(new Date("2026-10-19T19:30:00Z"), now, KHI)).toBe(true);
        expect(alertedToday(new Date("2026-10-19T18:59:00Z"), now, KHI)).toBe(false);
    });
});

describe("routing", () => {
    it("prefers an HR member on the checklist team", () => {
        expect(resolveHrOwnerId({ memberAssignments: [{ employeeId: 5, role: "MANAGER" }, { employeeId: 6, role: "HR" }] })).toBe(6);
        expect(resolveHrOwnerId({ memberAssignments: [{ employeeId: 7, role: "HR Manager" }] })).toBe(7);
    });

    it("falls back to the first HR task assignee, else null", () => {
        const tasks = [
            { id: 2, sortOrder: 2, assigneeType: "HR", assigneeId: 9 },
            { id: 1, sortOrder: 1, assigneeType: "MANAGER", assigneeId: 8 },
            { id: 3, sortOrder: 0, assigneeType: "HR", assigneeId: null },
        ];
        expect(resolveHrOwnerId({ memberAssignments: null, tasks })).toBe(9);
        expect(resolveHrOwnerId({ memberAssignments: [{ employeeId: 5, role: "BUDDY" }], tasks: [] })).toBeNull();
    });
});

describe("survey schedule", () => {
    const start = new Date("2026-06-01T00:00:00Z");

    it("issues each type once its day has passed", () => {
        expect(dueSurveyTypes(start, new Date("2026-06-30T00:00:00Z")).due).toEqual([]);
        expect(dueSurveyTypes(start, new Date("2026-07-01T00:00:00Z")).due).toEqual(["DAY_30"]);
        expect(dueSurveyTypes(start, new Date("2026-07-31T00:00:00Z")).due).toEqual(["DAY_30", "DAY_60"]);
    });

    it("does not issue a type whose day passed more than 30 days ago", () => {
        // 30 Aug: DAY_30 (1 Jul) is 60 days late, DAY_60 (31 Jul) exactly 30.
        const late = dueSurveyTypes(start, new Date("2026-08-30T00:00:00Z"));
        expect(late.due).toEqual(["DAY_60", "DAY_90"]);
        expect(late.stale).toEqual(["DAY_30"]);
    });

    it("is due a week after issue and reminded once in the last two days", () => {
        const issuedAt = new Date("2026-07-01T02:00:00Z");
        const dueAt = surveyDueAt(issuedAt);
        expect(dueAt.toISOString()).toBe("2026-07-08T02:00:00.000Z");
        const survey = { issuedAt, dueAt, submittedAt: null, remindedAt: null };
        expect(shouldRemindSurvey(survey, new Date(dueAt.getTime() - 3 * DAY))).toBe(false);
        expect(shouldRemindSurvey(survey, new Date(dueAt.getTime() - 2 * DAY))).toBe(true);
        expect(shouldRemindSurvey(survey, new Date(dueAt.getTime() - 1))).toBe(true);
        expect(shouldRemindSurvey(survey, dueAt)).toBe(false);
        expect(shouldRemindSurvey({ ...survey, remindedAt: new Date() }, new Date(dueAt.getTime() - DAY))).toBe(false);
        expect(shouldRemindSurvey({ ...survey, submittedAt: new Date() }, new Date(dueAt.getTime() - DAY))).toBe(false);
    });

    it("knows who has left", () => {
        expect(employeeHasLeft({ status: "active", employement_status: "active" })).toBe(false);
        expect(employeeHasLeft({ status: "Active", employement_status: null })).toBe(false);
        expect(employeeHasLeft({ status: "Separated", employement_status: "Separated" })).toBe(true);
        expect(employeeHasLeft({ status: "active", employement_status: "Inactive" })).toBe(true);
        expect(employeeHasLeft({ status: "active", separatedAt: new Date() })).toBe(true);
        expect(employeeHasLeft(null)).toBe(true);
    });
});

describe("completion per cohort", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    const jul = new Date("2026-07-03T00:00:00Z");
    const aug = new Date("2026-08-15T00:00:00Z");
    const row = (type, startDate, { submitted = false, overdue = false, issued = true } = {}) => ({
        type,
        startDate,
        issuedAt: issued ? new Date("2026-09-01T00:00:00Z") : null,
        dueAt: issued ? new Date(overdue ? "2026-09-08T00:00:00Z" : "2026-10-25T00:00:00Z") : null,
        submittedAt: submitted ? new Date("2026-09-03T00:00:00Z") : null,
    });

    it("counts issued, submitted, overdue and pending with a rate", () => {
        const { rows, totals } = surveyCompletion([
            row("DAY_30", jul, { submitted: true }),
            row("DAY_30", jul, { overdue: true }),
            row("DAY_30", jul),
            row("DAY_60", jul, { submitted: true }),
            row("DAY_30", aug, { submitted: true }),
            // Submitted through the portal before any issue: counts as issued.
            { type: "DAY_30", startDate: aug, issuedAt: null, dueAt: null, submittedAt: new Date() },
            // Neither issued nor submitted: not in the denominator.
            row("DAY_90", aug, { issued: false }),
        ], now);
        expect(rows).toEqual([
            { cohortMonth: "2026-07", surveyType: "DAY_30", issued: 3, submitted: 1, overdue: 1, pending: 1, completionRate: 33.3 },
            { cohortMonth: "2026-07", surveyType: "DAY_60", issued: 1, submitted: 1, overdue: 0, pending: 0, completionRate: 100 },
            { cohortMonth: "2026-08", surveyType: "DAY_30", issued: 2, submitted: 2, overdue: 0, pending: 0, completionRate: 100 },
        ]);
        expect(totals.find((t) => t.surveyType === "DAY_30")).toMatchObject({ issued: 5, submitted: 3, completionRate: 60 });
        expect(totals.find((t) => t.surveyType === "DAY_90")).toMatchObject({ issued: 0, completionRate: null });
        expect(cohortMonth(jul)).toBe("2026-07");
    });
});
