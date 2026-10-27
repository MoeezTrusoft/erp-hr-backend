// tests/unit/talentPoolPolicy.test.js
//
// FR-10 residue — the PURE talent-pool policy:
//
//   * the transition map is ONE-WAY: INVITED is the only non-terminal state, so
//     an answered invitation cannot be re-answered (a change of mind is a new
//     invitation, and the answer stays history)
//   * expiry is derived, not stored: a lapsed INVITED row is EXPIRED; terminal
//     rows are never "expired"
//   * segmentation is a closed vocabulary (an unknown key is refused, not
//     silently ignored) and skills are ANY-of
import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_INVITATION_VALIDITY_DAYS,
  INVITATION_STATUSES,
  INVITATION_TRANSITIONS,
  checkInvitationTransition,
  invitationExpiry,
  isInvitationExpired,
  isInvitationTerminal,
  matchesSegment,
  resolveInvitationResponse,
  segmentRejectionReasons,
  validateSegment,
} from "../../src/lib/talent-pool-policy.util.js";

describe("invitation lifecycle", () => {
  it("INVITED is the only non-terminal status", () => {
    for (const status of INVITATION_STATUSES) {
      expect(isInvitationTerminal(status)).toBe(status !== "INVITED");
    }
  });

  it("allows every forward move out of INVITED and none out of a terminal status", () => {
    expect(INVITATION_TRANSITIONS.INVITED).toEqual(["ACCEPTED", "DECLINED", "WITHDRAWN", "EXPIRED"]);
    for (const terminal of ["ACCEPTED", "DECLINED", "WITHDRAWN", "EXPIRED"]) {
      expect(INVITATION_TRANSITIONS[terminal]).toEqual([]);
      expect(checkInvitationTransition(terminal, "INVITED").ok).toBe(false);
    }
  });

  it("refuses re-answering an answered invitation", () => {
    const result = checkInvitationTransition("ACCEPTED", "DECLINED");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("HR-RECRUITMENT-INVITATION-TRANSITION-INVALID");
  });

  it("refuses an unknown status on either side", () => {
    expect(checkInvitationTransition("INVITED", "MAYBE").ok).toBe(false);
    expect(checkInvitationTransition("PENDING", "ACCEPTED").ok).toBe(false);
  });

  it("normalizes the candidate's answer to the two reachable states", () => {
    expect(resolveInvitationResponse("accept")).toBe("ACCEPTED");
    expect(resolveInvitationResponse("ACCEPTED")).toBe("ACCEPTED");
    expect(resolveInvitationResponse("decline")).toBe("DECLINED");
    expect(() => resolveInvitationResponse("maybe")).toThrow(/ACCEPTED or DECLINED/);
  });
});

describe("invitation expiry", () => {
  it("defaults to a bounded validity window", () => {
    const invitedAt = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = invitationExpiry({ invitedAt });
    const days = (expiresAt - invitedAt) / (24 * 60 * 60 * 1000);
    expect(days).toBe(DEFAULT_INVITATION_VALIDITY_DAYS);
  });

  it("honours an explicit validity window", () => {
    const invitedAt = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = invitationExpiry({ invitedAt, validityDays: 7 });
    expect((expiresAt - invitedAt) / (24 * 60 * 60 * 1000)).toBe(7);
  });

  it("refuses a nonsensical window", () => {
    expect(() => invitationExpiry({ validityDays: 0 })).toThrow(/whole number/);
    expect(() => invitationExpiry({ validityDays: -5 })).toThrow(/whole number/);
    expect(() => invitationExpiry({ validityDays: 4000 })).toThrow(/whole number/);
  });

  it("is expired only when INVITED and past the expiry", () => {
    const asOf = new Date("2026-02-01T00:00:00.000Z");
    expect(isInvitationExpired({ status: "INVITED", expiresAt: "2026-01-31T00:00:00.000Z" }, asOf)).toBe(true);
    expect(isInvitationExpired({ status: "INVITED", expiresAt: "2026-02-02T00:00:00.000Z" }, asOf)).toBe(false);
    // A terminal row is already settled; "expired" would misreport it.
    expect(isInvitationExpired({ status: "ACCEPTED", expiresAt: "2026-01-31T00:00:00.000Z" }, asOf)).toBe(false);
    expect(isInvitationExpired({ status: "INVITED", expiresAt: null }, asOf)).toBe(false);
    expect(isInvitationExpired(null, asOf)).toBe(false);
  });
});

describe("validateSegment", () => {
  it("accepts an empty segment (the whole pool)", () => {
    expect(validateSegment({}).ok).toBe(true);
    expect(validateSegment(null).ok).toBe(true);
  });

  it("REFUSES an unknown key rather than ignoring it", () => {
    const result = validateSegment({ skils: ["node"] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown segment filter/);
  });

  it("accepts a scalar where a list is expected", () => {
    const result = validateSegment({ skills: "Node" });
    expect(result.ok).toBe(true);
    expect(result.filters.skills).toEqual(["Node"]);
  });

  it("refuses an empty list", () => {
    expect(validateSegment({ skills: [] }).ok).toBe(false);
    expect(validateSegment({ skills: ["  "] }).ok).toBe(false);
  });

  it("refuses an inverted experience range and a negative number", () => {
    expect(validateSegment({ minExperienceYears: 5, maxExperienceYears: 2 }).ok).toBe(false);
    expect(validateSegment({ minExperienceYears: -1 }).ok).toBe(false);
  });

  it("refuses a non-integer invitedWithinDays", () => {
    expect(validateSegment({ invitedWithinDays: 1.5 }).ok).toBe(false);
  });
});

describe("matchesSegment", () => {
  const row = {
    candidateId: 1,
    poolNames: ["Engineering", "Backend"],
    skillNames: ["Node.js", "PostgreSQL"],
    location: "Lahore, PK",
    source: "Referral",
    experienceYears: 6,
    hasOpenInvitation: false,
    lastInvitedAt: null,
  };

  it("matches by pool, skill, location, source and experience", () => {
    expect(matchesSegment(row, { poolNames: ["engineering"] })).toBe(true);
    expect(matchesSegment(row, { skills: ["node.js"] })).toBe(true);
    expect(matchesSegment(row, { locations: ["lahore"] })).toBe(true);
    expect(matchesSegment(row, { sources: ["referral"] })).toBe(true);
    expect(matchesSegment(row, { minExperienceYears: 5, maxExperienceYears: 7 })).toBe(true);
  });

  it("skills are ANY-of, not all-of", () => {
    expect(matchesSegment(row, { skills: ["Node.js", "Kubernetes"] })).toBe(true);
    expect(matchesSegment(row, { skills: ["Kubernetes", "Go"] })).toBe(false);
  });

  it("excludes on an unmatched filter", () => {
    expect(matchesSegment(row, { skills: ["Go"] })).toBe(false);
    expect(matchesSegment(row, { minExperienceYears: 10 })).toBe(false);
    expect(matchesSegment(row, { hasOpenInvitation: true })).toBe(false);
    expect(matchesSegment(row, { locations: ["Karachi"] })).toBe(false);
  });

  it("an unknown experience is not a match for a bounded range", () => {
    expect(matchesSegment({ ...row, experienceYears: null }, { minExperienceYears: 1 })).toBe(false);
  });

  it("'invited recently' never matches a candidate never invited", () => {
    expect(matchesSegment({ ...row, lastInvitedAt: null }, { invitedWithinDays: 30 })).toBe(false);
    expect(matchesSegment({ ...row, lastInvitedAt: new Date() }, { invitedWithinDays: 30 })).toBe(true);
    const old = new Date();
    old.setDate(old.getDate() - 90);
    expect(matchesSegment({ ...row, lastInvitedAt: old }, { invitedWithinDays: 30 })).toBe(false);
  });

  it("an empty segment matches everything", () => {
    expect(matchesSegment(row, {})).toBe(true);
  });

  it("names the filters that rejected a row so the shortfall is attributable", () => {
    expect(segmentRejectionReasons(row, { skills: ["Go"] })).toContain("skills");
    expect(segmentRejectionReasons(row, { skills: ["Node.js"] })).toEqual([]);
  });
});
