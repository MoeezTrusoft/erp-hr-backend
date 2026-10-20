// Recruitment Phase 6 — an anonymous careers-portal applicant cannot tag
// themselves as a REFERRAL (a referral only comes from an employee through the
// internal board), exactly as they cannot claim INTERNAL; every other channel
// passes through as before.
import { jest, describe, it, expect } from "@jest/globals";

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: {} }));

const { parseSourceAttribution, PORTAL_UNCLAIMABLE_CHANNELS } = await import("../../src/services/publicPortal.service.js");

describe("parseSourceAttribution", () => {
    it("maps a claimed REFERRAL (any case) to the portal's default channel", () => {
        expect(parseSourceAttribution({ sourceChannel: "REFERRAL" }).sourceChannel).toBe("CAREER_SITE");
        expect(parseSourceAttribution({ sourceChannel: " referral " }).sourceChannel).toBe("CAREER_SITE");
        expect(parseSourceAttribution({ sourceChannel: "REFERRAL" }, { defaultChannel: "OTHER" }).sourceChannel).toBe("OTHER");
    });

    it("keeps the posting and the detail, and leaves the other channels alone", () => {
        const postings = [{ id: 88, isActive: true }];
        expect(parseSourceAttribution({ sourceChannel: "REFERRAL", sourcePostingId: 88, sourceDetail: "spring" }, { postings }))
            .toEqual({ sourceChannel: "CAREER_SITE", sourcePostingId: 88, sourceDetail: "spring" });
        expect(parseSourceAttribution({ sourceChannel: "INTERNAL" }).sourceChannel).toBe("CAREER_SITE");
        expect(parseSourceAttribution({ sourceChannel: "LINKEDIN" }).sourceChannel).toBe("LINKEDIN");
        expect(PORTAL_UNCLAIMABLE_CHANNELS).toEqual(["INTERNAL", "REFERRAL"]);
    });
});
