// tests/unit/offerMasking.test.js
//
// FR-09 residue — SENSITIVE-FIELD MASKING PARITY.
//
// `offerScopeWhere` decides which offers a caller may OPEN; masking decides what
// they see once open. A hiring manager legitimately reads the offers for their
// own requisitions (MANAGED scope) while `canSeeCompensation` is ORG/FINANCE
// only, so before this fix the row came back with salary, currency and the
// structured compensation block attached. These tests pin the second half of
// that ACL on BOTH read shapes (detail and page) and prove the marker is
// distinguishable from "no data".
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const prisma = {
  offer: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
};

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));

const { maskOfferForScope, maskOffersForScope } = await import("../../src/lib/recruitmentAccess.js");
const offerService = await import("../../src/services/offer.service.js");

const ORG = { level: "ORG", employeeId: 3, unrestricted: true, canSeeInternalNotes: true, canSeeCompensation: true };
const MANAGED = { level: "MANAGED", employeeId: 3, unrestricted: false, canSeeInternalNotes: false, canSeeCompensation: false };

const offerRow = () => ({
  id: 12,
  status: "DRAFT",
  salary: "120000.00",
  currency: "USD",
  compensation: { baseSalary: 120000, currency: "USD", bonus: 10000, benefits: ["health"] },
  notes: "negotiated",
  respondedAt: null,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("FR-09 — offer compensation masking", () => {
  it("ORG/FINANCE (canSeeCompensation) sees the row untouched", () => {
    const row = offerRow();
    expect(maskOfferForScope(row, ORG)).toBe(row); // same reference: no copy, no marker
  });

  it("a non-compensation scope loses salary, currency and the compensation block — and is TOLD", () => {
    const masked = maskOfferForScope(offerRow(), MANAGED);
    expect(masked.salary).toBeNull();
    expect(masked.currency).toBeNull();
    expect(masked.compensation).toBeNull();
    expect(masked.compensationRedacted).toBe(true);
    // Never a misleading zero: "restricted" is not "unpaid".
    expect(masked.salary).not.toBe(0);
  });

  it("keeps status and dates while masking internal notes", () => {
    const masked = maskOfferForScope(offerRow(), MANAGED);
    expect(masked.status).toBe("DRAFT");
    expect(masked.respondedAt).toBeNull();
    expect(masked.notes).toBeNull();
  });

  it("the list read masks every row, and the totals still answer how many", async () => {
    prisma.offer.findMany.mockResolvedValue([offerRow(), { ...offerRow(), id: 13 }]);
    prisma.offer.count.mockResolvedValue(2);

    const page = await offerService.listOffers({ tenantId: "t-1", scope: MANAGED });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((o) => o.salary === null && o.compensationRedacted === true)).toBe(true);
    expect(page.total).toBe(2);
  });

  it("the detail read masks too (the list is not the only door)", async () => {
    prisma.offer.findFirst.mockResolvedValue(offerRow());
    const detail = await offerService.getOffer(12, "t-1", MANAGED);
    expect(detail.salary).toBeNull();
    expect(detail.compensationRedacted).toBe(true);
  });

  it("an unscoped caller (internal service call) is passed through unchanged", async () => {
    prisma.offer.findFirst.mockResolvedValue(offerRow());
    const detail = await offerService.getOffer(12, "t-1", null);
    expect(detail.salary).toBe("120000.00");
  });

  it("maskOffersForScope is null-safe and preserves non-array input", () => {
    expect(maskOffersForScope(null, MANAGED)).toBeNull();
    expect(maskOffersForScope(undefined, MANAGED)).toBeUndefined();
  });
});
