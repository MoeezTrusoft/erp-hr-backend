import { createHash } from "node:crypto";

export const captureError = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export const jsonValue = (value) => JSON.parse(JSON.stringify(value));
export const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const MAX_CAPTURE_ROWS = 1000;
export function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    return typeof zone === "string" && zone.length > 0;
  } catch {
    return false;
  }
}
function wallAt(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
// The evaluator's punchedAt remains a wall-clock coordinate. occurredAt is a
// separate real instant; never reinterpret historical wall coordinates as UTC.
export function parseCaptureTimestamp(raw, timeZone = "UTC") {
  if (typeof raw !== "string" || !validTimeZone(timeZone))
    throw captureError("A valid timestamp and IANA timezone are required");
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      raw.trim(),
    );
  if (!match)
    throw captureError(
      "Timestamp must be YYYY-MM-DD HH:mm:ss with an optional UTC offset",
    );
  const [, year, month, day, hour, minute, second, fraction = "", offset] =
    match;
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const probe = new Date(`${wall}${fraction}Z`);
  if (
    !Number.isFinite(+probe) ||
    probe.toISOString().slice(0, 19) !== wall ||
    +year < 1970
  )
    throw captureError("Invalid calendar date or clock time");
  if (offset) {
    if (
      offset !== "Z" &&
      (+offset.slice(1, 3) > 14 ||
        +offset.slice(-2) > 59 ||
        (+offset.slice(1, 3) === 14 && +offset.slice(-2) !== 0))
    )
      throw captureError("Invalid UTC offset");
    const occurredAt = new Date(`${wall}${fraction}${offset}`);
    if (!Number.isFinite(+occurredAt)) throw captureError("Invalid timestamp");
    const localTime = wallAt(occurredAt, timeZone) + (fraction || "");
    return {
      punchedAt: new Date(`${localTime}Z`),
      occurredAt,
      localTime,
      timeZone,
    };
  }
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = new Date(+probe + hours * 3600000);
    offsets.add(
      +new Date(`${wallAt(sample, timeZone)}Z`) -
        (+sample - sample.getUTCMilliseconds()),
    );
  }
  const candidates = [...offsets]
    .map((delta) => new Date(+probe - delta))
    .filter((d) => wallAt(d, timeZone) === wall);
  if (candidates.length !== 1)
    throw captureError(
      candidates.length
        ? "Ambiguous daylight-saving time; include the UTC offset"
        : "This local time does not exist in the device timezone",
    );
  return {
    punchedAt: probe,
    occurredAt: candidates[0],
    localTime: wall + fraction,
    timeZone,
  };
}
export function parseCaptureRow(line, timeZone = "UTC") {
  if (typeof line !== "string" || line.length > 4096)
    throw captureError("Punch row must be text of at most 4096 characters");
  const [rawId, time, status, verify = "0", work = "0"] = line.split("\t");
  const deviceUserId = rawId?.trim();
  if (!deviceUserId || deviceUserId.length > 64)
    throw captureError("Device user ID is required (maximum 64 characters)");
  const number = (value, label, max) => {
    if (!/^\d+$/.test(value ?? "") || Number(value) > max)
      throw captureError(`Invalid ${label}`);
    return Number(value);
  };
  const direction = number(status, "punch status", 5);
  return {
    deviceUserId,
    ...parseCaptureTimestamp(time, timeZone),
    status: direction,
    verifyMode: number(verify, "verification mode", 255),
    workCode: number(work, "work code", 2147483647),
    rawLine: line,
  };
}
export function enrolmentEnd(row) {
  if (!row.effectiveTo) return Infinity;
  const date = new Date(row.effectiveTo);
  // Existing date-only end values mean the WHOLE last civil day.
  return +date + (date.toISOString().endsWith("T00:00:00.000Z") ? 86399999 : 0);
}
export function chooseEnrolment(rows, deviceUserId, sn, at, allowedTenantIds) {
  const history = rows.filter(
    (r) => r.deviceUserId === String(deviceUserId) && (!r.sn || r.sn === sn),
  );
  const current = history.filter(
    (r) => +new Date(r.effectiveFrom) <= +at && enrolmentEnd(r) >= +at,
  );
  const exact = current.filter((r) => r.sn === sn);
  const candidates = exact.length ? exact : current;
  if (candidates.length !== 1)
    return {
      reason: candidates.length
        ? "AMBIGUOUS_ENROLMENT"
        : history.length
          ? "OUTSIDE_ENROLMENT_PERIOD"
          : "UNKNOWN_IDENTITY",
    };
  const row = candidates[0];
  if (
    !row.tenantId ||
    (allowedTenantIds && !allowedTenantIds.includes(row.tenantId))
  )
    return { reason: "TENANT_NOT_PERMITTED" };
  return {
    employeeId: row.employeeId,
    tenantId: row.tenantId,
    enrolmentId: row.id,
  };
}
export function affectedDays(days) {
  return [
    ...new Set(
      days.flatMap((value) => {
        const d = new Date(value);
        d.setUTCHours(0, 0, 0, 0);
        return [-1, 0, 1].map((n) =>
          new Date(+d + n * 86400000).toISOString().slice(0, 10),
        );
      }),
    ),
  ].sort();
}
export function retryAt(attempts, now = new Date(), jitter = Math.random()) {
  return new Date(
    +now +
      Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12)) +
      Math.floor(jitter * 1000),
  );
}
