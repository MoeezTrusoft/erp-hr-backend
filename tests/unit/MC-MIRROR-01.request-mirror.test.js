// MULTI-COMPANY-MIRROR-01 (plan §2 R1/R2, §5) — the equivalence matrix that
// decides whether a raise in one company is mirrored to another. Akash's
// HomeVision/JOC pair must stay independent; Afsha's Homenet/HomeVision pair
// must mirror.
import { describe, it, expect } from "@jest/globals";
import { compareSibling } from "../../src/services/attendanceRequestMirror.service.js";

const ORIGIN = {
  employeeId: 159,
  type: "LATE_CHECKIN",
  expectedTime: new Date("2026-10-05T05:00:00.000Z"),
  actualTime: new Date("2026-10-05T05:47:00.000Z"),
};

const sibling = (over = {}) => ({
  id: 559,
  hasAccount: true,
  inactive: false,
  ...over,
});

const enrolment = (over = {}) => ({
  sn: "TTQ5261300360",
  deviceUserId: "306",
  ...over,
});
const schedule = (over = {}) => ({
  from: "10:00",
  to: "18:00",
  crossesMidnight: false,
  offDays: [6, 7],
  ...over,
});
const targetCase = (over = {}) => ({
  expectedTime: new Date("2026-10-05T05:00:00.000Z"),
  actualTime: new Date("2026-10-05T05:47:00.000Z"),
  ...over,
});

// `null` means "no enrolment / no schedule / no case", so it must not fall
// back to the dense default the way a spread would.
const pick = (over, key, build) => (key in over ? over[key] : build());

const compare = (over = {}) =>
  compareSibling({
    origin: ORIGIN,
    sibling: sibling(over.sibling),
    targetCase: over.targetCase === null ? null : targetCase(over.targetCase),
    originEnrolment: pick(over, "originEnrolment", enrolment),
    targetEnrolment: pick(over, "targetEnrolment", enrolment),
    originSchedule: pick(over, "originSchedule", schedule),
    targetSchedule: pick(over, "targetSchedule", schedule),
    routePublished: over.routePublished ?? true,
    alreadyRaised: over.alreadyRaised ?? false,
  });

describe("MC-MIRROR-01 sibling comparison", () => {
  it("mirrors when person, device, shift, case and route all agree (Afsha Homenet→HomeVision)", () => {
    expect(compare()).toEqual({
      verdict: "mirror",
      reason: "same person, device, shift and case",
    });
  });

  it("stays independent when the device serial differs (Akash HomeVision vs JOC)", () => {
    expect(
      compare({
        targetEnrolment: { sn: "A8LN181960262", deviceUserId: "9012" },
      }),
    ).toMatchObject({
      verdict: "skip",
      reason: "device differs",
    });
  });

  it("stays independent when only the device user id differs (same machine, two enrolments)", () => {
    expect(compare({ targetEnrolment: { deviceUserId: "200" } })).toMatchObject(
      {
        reason: "device differs",
      },
    );
  });

  it("stays independent when the shift differs (Akash 07:30–15:00 vs 16:00–16:30)", () => {
    expect(
      compare({ targetSchedule: { from: "16:00", to: "16:30" } }),
    ).toMatchObject({ verdict: "skip", reason: "shift differs" });
  });

  it("treats a different weekly-off set as a different shift", () => {
    expect(compare({ targetSchedule: { offDays: [5, 6] } })).toMatchObject({
      reason: "shift differs",
    });
  });

  it("compares the direction of a night shift, not just the clock strings", () => {
    expect(
      compare({ targetSchedule: { crossesMidnight: true } }),
    ).toMatchObject({ reason: "shift differs" });
  });

  it("skips when the sibling has no equivalent case (different grading or policy)", () => {
    expect(compare({ targetCase: null })).toMatchObject({
      reason: "no equivalent case",
    });
  });

  it("skips when the evidence differs by more than the stored case (same type, other punch)", () => {
    expect(
      compare({
        targetCase: { actualTime: new Date("2026-10-05T05:52:00.000Z") },
      }),
    ).toMatchObject({ reason: "evidence differs" });
  });

  it("skips a case that was already raised there, even when everything else agrees", () => {
    expect(compare({ alreadyRaised: true })).toMatchObject({
      reason: "already raised there",
    });
  });

  it("skips when the target company has no published attendance route", () => {
    expect(compare({ routePublished: false })).toMatchObject({
      reason: "approval route not published",
    });
  });

  it("skips an inactive sibling record", () => {
    expect(compare({ sibling: { inactive: true } })).toMatchObject({
      reason: "not active that day",
    });
  });

  it("skips a sibling that has no account in that company", () => {
    expect(compare({ sibling: { hasAccount: false } })).toMatchObject({
      reason: "no account in that company",
    });
  });

  it("is not confused by the no-enrolment case on either side", () => {
    expect(compare({ targetEnrolment: null })).toMatchObject({
      reason: "device differs",
    });
    expect(compare({ originEnrolment: null })).toMatchObject({
      reason: "device differs",
    });
  });
});
