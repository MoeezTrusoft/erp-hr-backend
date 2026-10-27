// Recruitment Phase 6 — HR's feedback view reads both stored survey shapes:
// { ratings, comments } (the HR feedback submit) and the flat question-id
// answers the new hire's self portal stores (q1_role_clarity ... q6_settled_rating).
// No data migration: old rows read as before.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const prisma = { onboardingChecklist: { findFirst: jest.fn() } };
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));

const { viewFeedback, readSurveyAnswers } = await import("../../../src/services/onboarding-portal.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";

const checklistWith = (surveys) => ({
    id: 70,
    employee: { employee_name: "Ayesha Khan", job_title: "Engineer" },
    surveys,
});

beforeEach(() => jest.clearAllMocks());

describe("readSurveyAnswers", () => {
    it("reads the RATINGS shape exactly as before", () => {
        expect(readSurveyAnswers({ ratings: { roleClarity: "Very Clear", teamSupport: "Yes", onboardingProcess: 4 }, comments: "Great start" })).toEqual({
            roleClarity: "Very Clear",
            teamSupport: "Yes",
            onboardingProcess: 4,
            welcomeRating: null,
            toolsReady: null,
            settledRating: null,
            comments: "Great start",
            format: "RATINGS",
        });
    });

    it("reads the self portal's flat answers for each survey type", () => {
        expect(readSurveyAnswers({ q1_role_clarity: "Somewhat Clear", q2_team_support: "Neutral", q4_welcome_rating: 5, q3_comments: "Thanks" })).toEqual({
            roleClarity: "Somewhat Clear",
            teamSupport: "Neutral",
            onboardingProcess: null,
            welcomeRating: 5,
            toolsReady: null,
            settledRating: null,
            comments: "Thanks",
            format: "FLAT",
        });
        expect(readSurveyAnswers({ q1_role_clarity: "Unclear", q2_team_support: "No", q5_tools_ready: "Partly" })).toMatchObject({ toolsReady: "Partly", comments: null, format: "FLAT" });
        expect(readSurveyAnswers({ q1_role_clarity: "Very Clear", q2_team_support: "Yes", q6_settled_rating: 3 })).toMatchObject({ settledRating: 3, format: "FLAT" });
    });

    it("finds flat keys a form nested inside ratings, and a blank answer reads as none", () => {
        expect(readSurveyAnswers({ ratings: { q1_role_clarity: "Very Clear", q2_team_support: "" }, comments: null })).toMatchObject({
            roleClarity: "Very Clear",
            teamSupport: null,
            comments: null,
            format: "RATINGS",
        });
    });

    it("anything else reads as empty, never throws", () => {
        for (const junk of [null, undefined, "text", 42, [], { ratings: "x" }, {}]) {
            expect(readSurveyAnswers(junk)).toMatchObject({ roleClarity: null, teamSupport: null, comments: null, format: null });
        }
    });
});

describe("viewFeedback", () => {
    it("returns both shapes in one table, with the additive per-type fields, tenant-scoped", async () => {
        const submittedAt = new Date("2026-10-19T10:00:00Z");
        prisma.onboardingChecklist.findFirst.mockResolvedValue(checklistWith([
            { type: "DAY_30", submittedAt, responses: { q1_role_clarity: "Very Clear", q2_team_support: "Yes", q4_welcome_rating: 4, q3_comments: "Lovely team" } },
            { type: "DAY_60", submittedAt: null, responses: { ratings: { roleClarity: "Unclear", teamSupport: "No", onboardingProcess: 2 }, comments: "Need a laptop" } },
        ]));
        const rows = await viewFeedback(70, TENANT);
        expect(prisma.onboardingChecklist.findFirst.mock.calls[0][0].where).toEqual({ id: 70, tenantId: TENANT });
        expect(rows).toEqual([
            {
                candidate: "Ayesha Khan",
                role: "Engineer",
                roleClarity: "Very Clear",
                teamSupport: "Yes",
                onboardingProcess: null,
                additionalComments: "Lovely team",
                submittedAt,
                surveyType: "DAY_30",
                welcomeRating: 4,
                toolsReady: null,
                settledRating: null,
                answerFormat: "FLAT",
            },
            {
                candidate: "Ayesha Khan",
                role: "Engineer",
                roleClarity: "Unclear",
                teamSupport: "No",
                onboardingProcess: 2,
                additionalComments: "Need a laptop",
                submittedAt: null,
                surveyType: "DAY_60",
                welcomeRating: null,
                toolsReady: null,
                settledRating: null,
                answerFormat: "RATINGS",
            },
        ]);
    });

    it("leaves out an issued survey that has no answers yet", async () => {
        prisma.onboardingChecklist.findFirst.mockResolvedValue(checklistWith([
            { type: "DAY_90", submittedAt: null, responses: null },
            { type: "DAY_60", submittedAt: null, responses: {} },
            { type: "DAY_30", submittedAt: new Date(), responses: { q1_role_clarity: "Very Clear" } },
        ]));
        const rows = await viewFeedback(70, TENANT);
        expect(rows.map((r) => r.surveyType)).toEqual(["DAY_30"]);
    });

    it("a missing checklist is still 404", async () => {
        prisma.onboardingChecklist.findFirst.mockResolvedValue(null);
        await expect(viewFeedback(70, TENANT)).rejects.toMatchObject({ status: 404 });
    });
});
