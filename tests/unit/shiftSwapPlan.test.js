import { planSwap, windowOf } from "../../src/lib/shiftSwapPlan.js";

const at = (h1, h2) => ({
  working: true,
  shift: { start: new Date(`2026-11-10T${h1}:00Z`), end: new Date(`2026-11-10T${h2}:00Z`) },
  pattern: { shift: { templateId: h1 === "09:00" ? 1 : 2 } },
});
const off = { working: false, reason: "OFF_DAY" };
const A = { id: 1, label: "A1" };
const B = { id: 2, label: "B2" };
const resolver = (table) => (id, day) => table[`${id}:${day}`];

describe("shift swap plan", () => {
  it("same day: each takes the other's shift", () => {
    const plan = planSwap({
      resolve: resolver({ "1:2026-11-10": at("09:00", "17:00"), "2:2026-11-10": at("17:00", "23:00") }),
      requester: A, target: B, fromDate: "2026-11-10",
    });
    expect(plan).toEqual([
      expect.objectContaining({ employeeId: 1, status: "on_shift", fromTime: "17:00", toTime: "23:00", templateId: 2 }),
      expect.objectContaining({ employeeId: 2, status: "on_shift", fromTime: "09:00", toTime: "17:00", templateId: 1 }),
    ]);
  });
  it("refuses identical shifts and a day off on a same-day swap", () => {
    const same = resolver({ "1:2026-11-10": at("09:00", "17:00"), "2:2026-11-10": at("09:00", "17:00") });
    expect(() => planSwap({ resolve: same, requester: A, target: B, fromDate: "2026-11-10" })).toThrow(/same shift/);
    const offDay = resolver({ "1:2026-11-10": at("09:00", "17:00"), "2:2026-11-10": off });
    expect(() => planSwap({ resolve: offDay, requester: A, target: B, fromDate: "2026-11-10" })).toThrow(/Both employees must be working/);
  });
  it("two days: hands over one day and takes the colleague's day, nobody double-booked", () => {
    const plan = planSwap({
      resolve: resolver({
        "1:2026-11-10": at("09:00", "17:00"), "2:2026-11-10": off,
        "2:2026-11-12": at("17:00", "23:00"), "1:2026-11-12": off,
      }),
      requester: A, target: B, fromDate: "2026-11-10", toDate: "2026-11-12",
    });
    expect(plan.map((w) => [w.employeeId, w.date, w.status])).toEqual([
      [2, "2026-11-10", "on_shift"], [1, "2026-11-10", "off"], [1, "2026-11-12", "on_shift"], [2, "2026-11-12", "off"],
    ]);
  });
  it("two days: refuses when the colleague already works the handed-over day", () => {
    const r = resolver({ "1:2026-11-10": at("09:00", "17:00"), "2:2026-11-10": at("09:00", "17:00"), "2:2026-11-12": at("09:00", "17:00"), "1:2026-11-12": off });
    expect(() => planSwap({ resolve: r, requester: A, target: B, fromDate: "2026-11-10", toDate: "2026-11-12" })).toThrow(/already working/);
  });
  it("refuses leave, holiday and rosters that are not ready", () => {
    expect(() => windowOf({ working: false, reason: "APPROVED_LEAVE" }, "A1", "2026-11-10")).toThrow(/approved leave/);
    expect(() => windowOf({ working: false, reason: "HOLIDAY" }, "A1", "2026-11-10")).toThrow(/holiday/);
    expect(() => windowOf({ working: null, reason: "MISSING_ROSTER" }, "A1", "2026-11-10")).toThrow(/not ready/);
  });
});
