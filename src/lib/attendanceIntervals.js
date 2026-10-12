// Pure interval accounting. Civil timestamps retain the legacy storage contract;
// actual instants, where available, determine elapsed time.
const minutes = (a, b) => Math.max(0, (+b - +a) / 60000);
const instant = (p) => (p.occurredAt ? new Date(p.occurredAt) : p.timestamp);
export function pairAttendance(punches) {
  const intervals = [],
    issues = [];
  let open = null;
  for (const p of punches) {
    if (p.type === "IN") {
      if (open) issues.push({ code: "REPEATED_IN", at: p.timestamp });
      else open = p;
    } else if (p.type === "OUT") {
      if (!open) issues.push({ code: "UNMATCHED_OUT", at: p.timestamp });
      else if (+p.timestamp <= +open.timestamp || +instant(p) <= +instant(open))
        issues.push({ code: "INVALID_INTERVAL", at: p.timestamp });
      else {
        intervals.push({
          start: open.timestamp,
          end: p.timestamp,
          occurredStart: instant(open),
          occurredEnd: instant(p),
          fromSiteId: open.siteId ?? null,
          toSiteId: p.siteId ?? null,
          inEventId: open.eventId ?? null,
          outEventId: p.eventId ?? null,
          elapsedMinutes: minutes(instant(open), instant(p)),
        });
        open = null;
      }
    } else issues.push({ code: "UNKNOWN_DIRECTION", at: p.timestamp });
  }
  return { intervals, issues, open };
}

export function unionWindows(windows = []) {
  const sorted = windows
      .filter((w) => w.start && w.end && +w.end > +w.start)
      .map((w) => ({ start: new Date(w.start), end: new Date(w.end) }))
      .sort((a, b) => a.start - b.start),
    result = [];
  for (const w of sorted) {
    const last = result.at(-1);
    if (last && w.start <= last.end)
      last.end = new Date(Math.max(+last.end, +w.end));
    else result.push(w);
  }
  return result;
}
export function windowMinutes(windows) {
  return unionWindows(windows).reduce(
    (sum, w) => sum + minutes(w.start, w.end),
    0,
  );
}
export function intersectWindows(a, b) {
  return unionWindows(
    a.flatMap((x) =>
      b.map((y) => ({
        start: new Date(Math.max(+x.start, +y.start)),
        end: new Date(Math.min(+x.end, +y.end)),
      })),
    ),
  );
}
export function intersectionMinutes(a, b) {
  return windowMinutes(intersectWindows(a, b));
}
export function accountAttendance(intervals, shift, policy = {}, credits = []) {
  const presenceMinutes = intervals.reduce((n, i) => n + i.elapsedMinutes, 0);
  const excluded = intersectionMinutes(intervals, shift.exclusions || []);
  const paidBreaks = unionWindows(shift.paidBreaks || []).map((w) => ({
    start: new Date(Math.max(+w.start, +shift.start)),
    end: new Date(Math.min(+w.end, +shift.end)),
  }));
  // A paid break is credited only within the observed working span.
  const span = intervals.length
    ? [{ start: intervals[0].start, end: intervals.at(-1).end }]
    : [];
  const paidBreakMinutes =
    intersectionMinutes(paidBreaks, span) -
    intersectionMinutes(paidBreaks, intervals);
  const travelWindows = unionWindows(
    credits
      .filter((c) => c.kind === "TRAVEL" && c.paid)
      .map((c) => ({
        start: new Date(c.start),
        end: new Date(c.end),
      })),
  );
  const travelMinutes =
    windowMinutes(travelWindows) -
    intersectionMinutes(
      travelWindows,
      unionWindows([...intervals, ...intersectWindows(paidBreaks, span)]),
    );
  const workedMinutes = Math.max(0, presenceMinutes - excluded);
  const regularMinutes = Math.max(
    0,
    (shift.start && shift.end
      ? intersectionMinutes(intervals, [shift])
      : presenceMinutes) -
      intersectionMinutes(
        intersectWindows(intervals, [shift]),
        shift.exclusions || [],
      ),
  );
  const overtimeMinutes = Math.max(
    0,
    workedMinutes - regularMinutes - (policy.overtimeAfterMinutes || 0),
  );
  const approvedWindows = credits
    .filter((c) => c.kind === "OVERTIME")
    .map((c) => ({
      start: new Date(c.start),
      end: new Date(c.end),
    }));
  const approvedWithinPresence = intersectionMinutes(
    intervals,
    approvedWindows,
  );
  const approvedWithinShift = intersectionMinutes(
    intervals,
    approvedWindows.map((w) => ({
      start: new Date(Math.max(+w.start, +shift.start)),
      end: new Date(Math.min(+w.end, +shift.end)),
    })),
  );
  const approvedOvertimeMinutes =
    policy.overtimeNeedsApproval === false
      ? overtimeMinutes
      : Math.min(
          overtimeMinutes,
          Math.max(
            0,
            approvedWithinPresence -
              approvedWithinShift -
              (intersectionMinutes(
                intersectWindows(intervals, approvedWindows),
                shift.exclusions || [],
              ) -
                intersectionMinutes(
                  intersectWindows(
                    intersectWindows(intervals, approvedWindows),
                    [shift],
                  ),
                  shift.exclusions || [],
                )),
          ),
        );
  return {
    presenceMinutes,
    workedMinutes,
    regularMinutes,
    unpaidBreakMinutes: excluded,
    paidBreakMinutes: Math.max(0, paidBreakMinutes),
    travelMinutes: Math.max(0, travelMinutes),
    overtimeMinutes,
    approvedOvertimeMinutes,
    payableMinutes:
      regularMinutes +
      Math.max(0, paidBreakMinutes) +
      Math.max(0, travelMinutes) +
      approvedOvertimeMinutes,
    creditedMinutes:
      workedMinutes +
      Math.max(0, paidBreakMinutes) +
      Math.max(0, travelMinutes),
  };
}
