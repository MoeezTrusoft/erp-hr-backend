const DAY_MS = 86400000;
const isoDow = (d) => new Date(d).getUTCDay() || 7;
export function shiftCandidates(pattern, day) {
  if (typeof pattern === 'function') pattern = pattern(day);
  const mk = (hhmm) => {
    const m =
      typeof hhmm === 'string' ? hhmm.trim().match(/^(\d{1,2}):(\d{2})/) : null;
    if (!m) return null;
    const d = new Date(day);
    d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  };
  const build = (raw) => {
    const start = mk(raw?.from);
    let end = mk(raw?.to);
    if (start && end && end <= start) end = new Date(end.getTime() + DAY_MS);
    return { start, end };
  };

  const rotating = Array.isArray(pattern?.rotatingShifts)
    ? pattern.rotatingShifts
    : null;
  if (Array.isArray(pattern?.shifts) && pattern.shifts.length)
    return pattern.shifts.map(build).filter(s=>s.start&&s.end).sort((a,b)=>a.start-b.start);
  if (rotating?.length && Array.isArray(pattern?.cycle?.sequence)) {
    const cycle = pattern.cycle;
    const offset = Math.round(
      (new Date(day) - new Date(`${cycle.anchor}T00:00:00Z`)) / DAY_MS,
    );
    const index = ((offset % cycle.days) + cycle.days) % cycle.days;
    const shiftIndex = cycle.sequence[index];
    return shiftIndex == null
      ? []
      : [build(rotating[shiftIndex])].filter((s) => s.start && s.end);
  }
  if (rotating?.length) return rotating.map(build).filter((s) => s.start);

  // HR-ROSTER-04 — this weekday may work different hours.
  //
  // `shift` holds one {from,to}, so a roster could not say "Saturday is a short
  // day". Akash works 07:30-15:00 on weekdays and 10:18-13:42 on Saturdays;
  // judged against the single window every Saturday came out as a 2-3 hour day,
  // under the half-day threshold, stored ABSENT — five unpaid days for work he
  // actually did.
  //
  // Keyed by ISO weekday (Monday=1 .. Sunday=7) and read as a string, because
  // schedule_pattern round-trips through JSONB and numeric keys come back as
  // strings. A malformed entry falls through to `shift` rather than erasing the
  // roster: losing the window entirely would make every scan unrostered, which
  // is worse than the wrong hours.
  const byDay = pattern?.shiftByDay?.[String(isoDow(day))];
  const perDay = byDay ? build(byDay) : null;
  if (perDay?.start && perDay?.end) return [perDay];

  const single = build(pattern?.shift);
  return single.start ? [single] : [];
}

/**
 * The shift window for a day. `anchor` is the arrival that day, and for a
 * rotating roster it decides WHICH window applies: a 22:03 punch is an on-time
 * night start, not a twelve-hour-late day start. Without an anchor the first
 * window is used — that path only feeds tomorrow's check-out cutoff, where no
 * arrival exists yet.
 */
export function shiftFor(pattern, day, anchor) {
  const options = shiftCandidates(pattern, day);
  if (!options.length) return { start: null, end: null };
  if (options.length === 1 || !anchor) return options[0];

  const t = new Date(anchor).getTime();
  let best = null;
  for (const opt of options) {
    // Compare across midnight: a 23:50 punch is 10 minutes from a 00:00 start.
    let d = Math.abs(t - opt.start.getTime());
    d = Math.min(d, Math.abs(d - DAY_MS));
    if (!best || d < best.d) best = { d, opt };
  }
  return best.opt;
}
