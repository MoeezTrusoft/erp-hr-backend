import { parseCaptureTimestamp } from "./attendanceCapture.js";

export function civilNow(now, timeZone) {
  return parseCaptureTimestamp(new Date(now).toISOString(), timeZone).punchedAt;
}
export function civilInstant(value, timeZone) {
  if (!value) return null;
  return parseCaptureTimestamp(
    new Date(value).toISOString().replace(/Z$/, ""),
    timeZone,
  ).occurredAt;
}
export function shiftDeadline(shift, policy = {}) {
  return shift?.end
    ? new Date(+shift.end + (policy.checkoutLeniencyMin ?? 240) * 60000)
    : null;
}
