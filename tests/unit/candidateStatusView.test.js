// tests/unit/candidateStatusView.test.js
//
// Phase 5 / §3.5a — the CANDIDATE-VISIBLE status projection. The decision
// record's rule is "the external state set stays SIMPLER than the internal ATS
// state machine" and "never expose internal rejection reason codes, recruiter
// comments or AI scores". These tests pin the mapping and its refusals:
//
//   * every internal stage maps to exactly one visible status — and on_hold
//     deliberately shows as Under Review (never a parking state);
//   * an ACCEPTED offer sharpens `offer` into Offer Accepted;
//   * an unknown stage returns NULL (refuse, never guess);
//   * the list projection carries job title + simplified status ONLY — no
//     stage names, no scores, no ids — sorted newest-first.
import { describe, it, expect } from "@jest/globals";
import {
    projectCandidateStatus,
    projectCandidateStatusList,
    visibleToLabel,
    CANDIDATE_VISIBLE_STATUSES,
} from "../../src/lib/candidate-status-view.util.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");

describe("Phase 5 / §3.5a — the candidate-visible projection", () => {
    it("maps every internal stage to its simplified visible status", () => {
        const cases = [
            ["applied", "SUBMITTED"],
            ["screening", "UNDER_REVIEW"],
            ["interview", "INTERVIEW"],
            ["offer", "OFFER"],
            ["hired", "OFFER_ACCEPTED"],
            ["rejected", "CLOSED"],
            ["withdrawn", "WITHDRAWN"],
            // on_hold is internal parking — never shown as such.
            ["on_hold", "UNDER_REVIEW"],
        ];
        for (const [stage, visible] of cases) {
            expect(projectCandidateStatus({ stage, updatedAt: NOW }).status).toBe(visible);
        }
    });

    it("an ACCEPTED offer sharpens OFFER into OFFER_ACCEPTED", () => {
        expect(projectCandidateStatus({ stage: "offer" }, { offerStatus: "ACCEPTED" }).status).toBe("OFFER_ACCEPTED");
        expect(projectCandidateStatus({ stage: "offer" }, { offerStatus: "SENT" }).status).toBe("OFFER");
        expect(projectCandidateStatus({ stage: "offer" }, { offerStatus: null }).status).toBe("OFFER");
    });

    it("rejects an unknown stage rather than guessing", () => {
        expect(projectCandidateStatus({ stage: "teleporting" })).toBeNull();
        expect(projectCandidateStatus({})).toBeNull();
        expect(projectCandidateStatus(null)).toBeNull();
    });

    it("exposes labels and the frozen visible vocabulary", () => {
        expect(visibleToLabel("OFFER_ACCEPTED")).toBe("Offer Accepted / Onboarding");
        expect(visibleToLabel("NOPE")).toBeNull();
        expect(CANDIDATE_VISIBLE_STATUSES).toHaveLength(7);
    });

    it("projects the list to title + simplified status ONLY, newest first", () => {
        const view = projectCandidateStatusList([
            {
                stage: "interview",
                updatedAt: new Date("2026-09-01T10:00:00Z"),
                jobRequisition: { title: "Backend Engineer" },
                // Fields that must NOT leak:
                score: 87,
                offer: null,
            },
            {
                stage: "applied",
                updatedAt: new Date("2026-09-10T10:00:00Z"),
                jobRequisition: { title: "QA Lead" },
            },
            {
                stage: "rejected",
                updatedAt: new Date("2026-09-05T10:00:00Z"),
                jobRequisition: { title: "Ops Analyst" },
            },
            { stage: "corrupted" }, // unknown stage: dropped, never guessed
        ]);

        expect(view.applications).toHaveLength(3);
        expect(view.applications.map((a) => a.status)).toEqual(["SUBMITTED", "CLOSED", "INTERVIEW"]);
        expect(view.applications[0]).toEqual({
            jobTitle: "QA Lead",
            status: "SUBMITTED",
            label: "Submitted",
            updatedAt: "2026-09-10T10:00:00.000Z",
        });
        // No leaked field survives the projection.
        for (const app of view.applications) {
            expect(Object.keys(app).sort()).toEqual(["jobTitle", "label", "status", "updatedAt"]);
        }
    });

    it("an empty list stays an empty list — the endpoint renders it like any other empty", () => {
        expect(projectCandidateStatusList([]).applications).toEqual([]);
    });
});
