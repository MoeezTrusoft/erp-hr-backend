// Recruitment Phase 6 — an anonymous careers-portal applicant may tag only a
// public channel (careers site, LinkedIn, Indeed, other): REFERRAL, INTERNAL,
// AGENCY, TALENT_POOL and RECRUITER fall back to the portal's default.
import { jest, describe, it, expect } from "@jest/globals";

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: {} }));

const { parseSourceAttribution, PORTAL_CLAIMABLE_CHANNELS } = await import("../../src/services/public-portal.service.js");

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
        expect(PORTAL_CLAIMABLE_CHANNELS).toEqual(["CAREER_SITE", "LINKEDIN", "INDEED", "OTHER"]);
    });

    it("never lets an applicant claim a channel another path owns", () => {
        for (const channel of ["AGENCY", "TALENT_POOL", "RECRUITER", "agency", "INTERNAL", "REFERRAL"]) {
            expect(parseSourceAttribution({ sourceChannel: channel }).sourceChannel).toBe("CAREER_SITE");
        }
        // Public boards and the generic channel still pass through.
        for (const channel of ["INDEED", "LINKEDIN", "OTHER", "CAREER_SITE"]) {
            expect(parseSourceAttribution({ sourceChannel: channel }).sourceChannel).toBe(channel);
        }
        // An unknown value normalises to OTHER, which is claimable.
        expect(parseSourceAttribution({ sourceChannel: "FACEBOOK" }).sourceChannel).toBe("OTHER");
    });
});
