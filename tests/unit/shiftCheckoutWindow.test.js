import { describe, expect, it } from "@jest/globals";
import { boundedCheckout, CHECKIN_WINDOW_MIN } from "../../src/lib/shiftCheckout.js";

const t = (s) => new Date(s);
const night = { start: t("2026-10-01T15:00:00Z"), end: t("2026-10-02T00:00:00Z") };
const day = { start: t("2026-10-02T04:00:00Z"), end: t("2026-10-02T13:00:00Z") };

describe("boundedCheckout: the check-out window", () => {
  it("runs until the next shift's check-in window opens, whatever the leniency minutes say", () => {
    const next = t("2026-10-02T15:00:00Z");
    // 15:00 next shift, 5 h window: closes 10:00, not end + 540 minutes (09:00).
    expect(+boundedCheckout(night, { checkoutLeniencyMin: 540 }, next)).toBe(+t("2026-10-02T10:00:00Z"));
    expect(+boundedCheckout(night, { checkoutLeniencyMin: 60 }, next)).toBe(+t("2026-10-02T10:00:00Z"));
    expect(CHECKIN_WINDOW_MIN).toBe(300);
  });

  it("never closes before the shift ends, and never more than a day after it", () => {
    // Back-to-back shifts: the window would open before this one ends.
    expect(+boundedCheckout(day, {}, t("2026-10-02T14:00:00Z"))).toBe(+day.end);
    // A weekend gap: next shift is three days away, the window still stops a day after the end.
    expect(+boundedCheckout(day, {}, t("2026-10-05T04:00:00Z"))).toBe(+day.end + 86400000);
  });

  it("falls back to the leniency minutes when no later shift is rostered", () => {
    expect(+boundedCheckout(day, { checkoutLeniencyMin: 240 }, null)).toBe(+day.end + 240 * 60000);
    expect(+boundedCheckout(day, {}, null)).toBe(+day.end + 240 * 60000);
  });

  it("still lets HR's roster cutoff win, never within an hour of the next shift", () => {
    const shift = { ...night, checkoutCutoff: t("2026-10-02T08:00:00Z") };
    expect(+boundedCheckout(shift, {}, t("2026-10-02T15:00:00Z"))).toBe(+t("2026-10-02T08:00:00Z"));
    const late = { ...night, checkoutCutoff: t("2026-10-02T14:30:00Z") };
    expect(+boundedCheckout(late, {}, t("2026-10-02T15:00:00Z"))).toBe(+t("2026-10-02T14:00:00Z"));
  });

  it("has no deadline without a shift end", () => {
    expect(boundedCheckout({ start: day.start }, {}, null)).toBeNull();
  });
});
