// A punch is stored with the time the machine said AND the time the server says it was. When a machine's clock is
// wrong (the heartbeat measures it), the punch counts at the server's time, so a machine that is hours off never
// moves a day or a shift. The machine's own time stays on the punch as evidence.
export const DRIFT_SECONDS = 120; // beyond this a machine counts as drifting (the same bar the health monitor uses)
export const SAMPLE_MAX_AGE_MS = 6 * 3600 * 1000; // an older clock reading is not trusted for correcting punches
export const FUTURE_LIMIT_MS = 24 * 3600 * 1000; // a punch still this far ahead of the server after correction is held for review

/** The offset to correct by, or 0 when the machine's clock is good or was not measured recently enough. */
export function usableOffsetSeconds(device, now = new Date()) {
  const offset = device?.clockOffsetSeconds;
  const sampled = device?.clockSampledAt ? new Date(device.clockSampledAt) : null;
  if (!Number.isFinite(offset) || Math.abs(offset) <= DRIFT_SECONDS) return 0;
  if (!sampled || now - sampled > SAMPLE_MAX_AGE_MS) return 0;
  return offset;
}

/**
 * The punch at the server's time. `wallAt` turns an instant into the company's wall-clock text (it is passed in so
 * this file stays free of the capture module). The machine's reading is kept under `machine`.
 */
export function correctPunch(punch, offsetSeconds, wallAt) {
  if (!offsetSeconds) return punch;
  const shift = offsetSeconds * 1000;
  const occurredAt = new Date(+punch.occurredAt - shift);
  const localTime = wallAt(occurredAt, punch.timeZone) + (String(punch.localTime ?? '').match(/\.\d{1,3}$/)?.[0] ?? '');
  return {
    ...punch,
    punchedAt: new Date(`${localTime}Z`),
    occurredAt,
    localTime,
    machine: { punchedAt: punch.punchedAt, occurredAt: punch.occurredAt, localTime: punch.localTime },
    clockOffsetSeconds: offsetSeconds,
  };
}

/** After correction, is the punch still absurdly far ahead of the server? Then a person looks at it. */
export const tooFarAhead = (punch, now = new Date()) => +punch.occurredAt - +now > FUTURE_LIMIT_MS;

export const describeOffset = (seconds) => {
  const abs = Math.abs(Math.round(seconds));
  const h = Math.floor(abs / 3600), m = Math.floor((abs % 3600) / 60);
  const span = [h ? `${h} hour${h === 1 ? '' : 's'}` : '', m || !h ? `${m} minute${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ');
  return `${span} ${seconds > 0 ? 'ahead of' : 'behind'} the server`;
};
