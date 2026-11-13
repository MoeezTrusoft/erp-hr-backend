// MULTI-COMPANY-MIRROR-01 (plan §2 R1/R2, §5) — the equivalence matrix that
// decides whether a raise in one company is mirrored to another. Akash's
// HomeVision/JOC pair must stay independent; Afsha's Homenet/HomeVision pair
// must mirror.
import { describe, it, expect } from "@jest/globals";
import {
  compareSibling,
  editedSiblingReason,
  isUnlinkedTwin,
} from "../../src/services/attendanceRequestMirror.service.js";

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
    expect(compare()).toMatchObject({
      verdict: "mirror",
      reason: "same person, device, shift and case",
      onBehalf: false,
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

  // The live path hands over the WorkSchedule rows, not the extracted pattern.
  it("mirrors when both schedules are WorkSchedule rows carrying schedule_pattern", () => {
    const row = (pattern) => ({
      schedule_pattern: pattern,
      schedule_name: "x",
    });
    const pattern = {
      shift: { from: "10:00", to: "18:00", crossesMidnight: false },
      offDays: [7, 6],
    };
    expect(
      compare({
        originSchedule: row(pattern),
        targetSchedule: row({ ...pattern, offDays: [6, 7] }),
      }),
    ).toMatchObject({
      verdict: "mirror",
      reason: "same person, device, shift and case",
    });
  });

  it("treats a WorkSchedule row with a missing pattern as a different shift", () => {
    expect(
      compare({ targetSchedule: { schedule_pattern: null } }),
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

  // Issue 420 — Habib 588/589 and Shah Hasan 649/643 have no login in either
  // company; the request is filed there by that company's HR instead of the
  // pair silently staying independent.
  it("mirrors a sibling with no account when that company's HR can file it", () => {
    expect(
      compare({
        sibling: { hasAccount: false, hrActor: { employeeId: 12, userId: 34 } },
      }),
    ).toMatchObject({ verdict: "mirror", onBehalf: true });
  });

  it("skips a sibling with no account and no HR to file it", () => {
    expect(compare({ sibling: { hasAccount: false, hrActor: null } })).toMatchObject({
      reason: "no login and no HR to raise it for them in that company",
    });
  });

  it("never files on behalf when the sibling has its own account", () => {
    expect(
      compare({ sibling: { hasAccount: true, hrActor: { employeeId: 12, userId: 34 } } }),
    ).toMatchObject({ verdict: "mirror", onBehalf: false });
  });

  it("is not confused by the no-enrolment case on either side", () => {
    expect(compare({ targetEnrolment: null })).toMatchObject({
      reason: "device differs",
    });
    expect(compare({ originEnrolment: null })).toMatchObject({
      reason: "device differs",
    });
  });

  it("mirrors when several enrolments are in force and the sets share one device (Shah Hasan BOC/JOC)", () => {
    const both = [
      enrolment({ sn: "A8LN181960262", deviceUserId: "9013" }),
      enrolment({ sn: "EUF7243800353", deviceUserId: "9014" }),
    ];
    expect(
      compare({ originEnrolment: both, targetEnrolment: [...both].reverse() }),
    ).toMatchObject({ verdict: "mirror" });
  });

  it("stays independent when the device sets do not overlap", () => {
    expect(
      compare({
        originEnrolment: [
          enrolment({ sn: "TTQ5261300360", deviceUserId: "200" }),
        ],
        targetEnrolment: [
          enrolment({ sn: "A8LN181960262", deviceUserId: "9012" }),
        ],
      }),
    ).toMatchObject({ reason: "device differs" });
  });

  it("stays independent when the serial is shared but the device user id is not", () => {
    expect(
      compare({ targetEnrolment: [enrolment({ deviceUserId: "200" })] }),
    ).toMatchObject({ reason: "device differs" });
  });
});

// Issue 353b (operator, 2026-11-05) — an edited message follows the group: the
// sibling keeps the clause that says where the request came from, and takes the
// editor's new text.
// Issue 420 — Habib 588 (Homenet) and 589 (HomeVision) had no personId, so the
// mirror could not see they were one person. Pairing now falls back to the
// shared in-force enrolment plus an identical name, and never adopts a record
// that is already linked to somebody else.
describe("MC-MIRROR-01 unlinked twin pairing", () => {
  const originEmployee = {
    id: 588,
    tenant_id: "homenet",
    employee_name: "Syed Habib Hussain Zaidi",
    personId: null,
  };
  const twin = (over = {}) => ({
    id: 589,
    tenant_id: "homevision",
    employee_name: "Syed Habib Hussain Zaidi",
    personId: null,
    ...over,
  });
  const keys = new Set(["TTQ5261300360|309"]);
  const enrolment = { sn: "TTQ5261300360", deviceUserId: "309" };
  const pair = (over = {}) =>
    isUnlinkedTwin({
      originEmployee,
      sibling: twin(over.sibling),
      keys,
      enrolment: over.enrolment ?? enrolment,
    });

  it("pairs two unlinked records sharing one enrolment and one name", () => {
    expect(pair()).toBe(true);
  });
  it("ignores case, spacing and punctuation in the name", () => {
    expect(pair({ sibling: { employee_name: "  syed   habib hussain ZAIDI " } })).toBe(true);
  });
  it("never adopts a record already linked to a person", () => {
    expect(pair({ sibling: { personId: "20cc8a00-077c-5a77-926f-0701d6e591e4" } })).toBe(false);
  });
  it("does not pair on a different name (a shared machine used by two people)", () => {
    expect(pair({ sibling: { employee_name: "Muhammad Azeem" } })).toBe(false);
  });
  it("does not pair on a different device user id on the same machine", () => {
    expect(pair({ enrolment: { sn: "TTQ5261300360", deviceUserId: "310" } })).toBe(false);
  });
  it("does not pair with the origin record, another company in the same tenant, or nobody", () => {
    expect(pair({ sibling: { id: 588 } })).toBe(false);
    expect(pair({ sibling: { tenant_id: "homenet" } })).toBe(false);
    expect(isUnlinkedTwin({ originEmployee, sibling: null, keys, enrolment })).toBe(false);
  });
});

describe("an edit follows a mirrored request", () => {
  it("keeps the sibling's own mirror clause and replaces the message", () => {
    const siblingReason =
      "The reader was down at the gate.\n\nRaised in Homenet and mirrored to HomeVision automatically (same person, device and shift).";
    expect(editedSiblingReason(siblingReason, "The reader was down 09:00-09:30.")).toBe(
      "The reader was down 09:00-09:30.\n\nRaised in Homenet and mirrored to HomeVision automatically (same person, device and shift).",
    );
  });

  it("trims the editor's text and never invents a clause", () => {
    expect(editedSiblingReason("old text", "  new text  ")).toBe("new text");
  });
});
