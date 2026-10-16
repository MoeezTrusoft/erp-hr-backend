import { parseCaptureTimestamp } from "./attendanceCapture.js";
import { boundedCheckout } from './shiftCheckout.js';

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
  return boundedCheckout(shift, policy);
}
