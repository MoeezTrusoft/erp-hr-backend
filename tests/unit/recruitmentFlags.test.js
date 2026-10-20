// tests/unit/recruitmentFlags.test.js
//
// Phase 15 — the feature-flag contract:
//   * defaults are decisions (workflow/portal/offer/analytics ON; AI and
//     retention-apply OFF, per §7.1b and §8)
//   * env values parse truthy/falsy; an UNKNOWN value falls back to the
//     documented default (a typo must never take a feature down)
//   * reads happen AT CALL TIME — flipping the env is visible immediately
//   * reading never throws

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

const { isRecruitmentFlagEnabled, recruitmentFlagSnapshot, RECRUITMENT_FLAG_DEFINITIONS } = await import(
    "../../src/lib/recruitmentFlags.js"
);

const ENV_KEYS = Object.values(RECRUITMENT_FLAG_DEFINITIONS).map((d) => d.env);

beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
});

describe("recruitmentFlags — defaults (Phase 15)", () => {
    it("workflow enforcement, offers/handoff, portal and analytics default ON", () => {
        expect(isRecruitmentFlagEnabled("workflow")).toBe(true);
        expect(isRecruitmentFlagEnabled("offerHandoff")).toBe(true);
        expect(isRecruitmentFlagEnabled("portal")).toBe(true);
        expect(isRecruitmentFlagEnabled("analytics")).toBe(true);
    });

    it("AI and retention automation default OFF (§7.1b, §8)", () => {
        expect(isRecruitmentFlagEnabled("ai")).toBe(false);
        expect(isRecruitmentFlagEnabled("retention")).toBe(false);
    });

    it("approval SLA reminders, auto-publish and posting expiry default OFF (F-02, F-04) and flip from env", () => {
        expect(isRecruitmentFlagEnabled("approvalSla")).toBe(false);
        expect(isRecruitmentFlagEnabled("autoPublish")).toBe(false);
        expect(isRecruitmentFlagEnabled("postingExpiry")).toBe(false);
        process.env.HR_RECRUITMENT_APPROVAL_SLA = "on";
        process.env.HR_RECRUITMENT_AUTO_PUBLISH = "true";
        process.env.HR_RECRUITMENT_POSTING_EXPIRY = "yes";
        expect(isRecruitmentFlagEnabled("approvalSla")).toBe(true);
        expect(isRecruitmentFlagEnabled("autoPublish")).toBe(true);
        expect(isRecruitmentFlagEnabled("postingExpiry")).toBe(true);
        process.env.HR_RECRUITMENT_APPROVAL_SLA = "maybe";
        expect(isRecruitmentFlagEnabled("approvalSla")).toBe(false); // unknown → default off
    });

    it("an unknown key fails closed to off", () => {
        expect(isRecruitmentFlagEnabled("nonexistent")).toBe(false);
    });
});

describe("recruitmentFlags — env parsing", () => {
    it("accepts the truthy vocabulary", () => {
        for (const v of ["1", "true", "yes", "on", "enabled", "TRUE", "On"]) {
            process.env.HR_RECRUITMENT_AI = v;
            expect(isRecruitmentFlagEnabled("ai")).toBe(true);
        }
    });

    it("accepts the falsy vocabulary", () => {
        process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT = "0";
        expect(isRecruitmentFlagEnabled("workflow")).toBe(false);
        process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT = "disabled";
        expect(isRecruitmentFlagEnabled("workflow")).toBe(false);
    });

    it("an unknown value falls back to the DEFAULT, not to false", () => {
        process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT = "maybe";
        expect(isRecruitmentFlagEnabled("workflow")).toBe(true); // default true
        process.env.HR_RECRUITMENT_AI = "maybe";
        expect(isRecruitmentFlagEnabled("ai")).toBe(false); // default false
    });

    it("an empty value falls back to the default", () => {
        process.env.HR_RECRUITMENT_PORTAL_TEST = "x"; // ensure no cross-talk
        process.env.HR_RECRUITMENT_PUBLIC_PORTAL = "";
        expect(isRecruitmentFlagEnabled("portal")).toBe(true);
    });

    it("reads happen at call time — flipping the env is visible immediately", () => {
        process.env.HR_RECRUITMENT_PUBLIC_PORTAL = "true";
        expect(isRecruitmentFlagEnabled("portal")).toBe(true);
        process.env.HR_RECRUITMENT_PUBLIC_PORTAL = "false";
        expect(isRecruitmentFlagEnabled("portal")).toBe(false);
    });
});

describe("recruitmentFlags — snapshot", () => {
    it("exposes every flag with env, value, default and description", () => {
        const snap = recruitmentFlagSnapshot();
        expect(Object.keys(snap).sort()).toEqual(["ai", "analytics", "approvalSla", "autoPublish", "canonicalDashboard", "offerHandoff", "portal", "postingExpiry", "retention", "workflow"]);
        for (const [key, entry] of Object.entries(snap)) {
            expect(entry.env).toBe(RECRUITMENT_FLAG_DEFINITIONS[key].env);
            expect(typeof entry.enabled).toBe("boolean");
            expect(typeof entry.description).toBe("string");
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });
});
