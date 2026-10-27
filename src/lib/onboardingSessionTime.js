// Return one real UTC instant. Refuse DST gaps and repeated local times.
export function sessionInstant(date, time, timeZone) {
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    typeof timeZone !== "string" ||
    timeZone.length > 100
  )
    throw Error("Use a valid session date, HH:mm time and IANA time zone");
  const local = Date.parse(date + "T" + time + ":00.000Z");
  if (
    !Number.isFinite(local) ||
    new Date(local).toISOString().slice(0, 10) !== date
  )
    throw Error("Use a valid session date");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const civil = (ms) => {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
    );
    return (
      p.year +
      "-" +
      p.month +
      "-" +
      p.day +
      "T" +
      p.hour +
      ":" +
      p.minute +
      ":" +
      p.second +
      ".000Z"
    );
  };
  const offsets = new Set(
    [-86400000, 0, 86400000].map(
      (delta) => Date.parse(civil(local + delta)) - (local + delta),
    ),
  );
  const candidates = [...offsets]
    .map((offset) => local - offset)
    .filter((ms) => Date.parse(civil(ms)) === local);
  if (candidates.length !== 1)
    throw Error(
      "This local time is missing or repeated by daylight saving; choose another time",
    );
  return new Date(candidates[0]);
}
export function sessionLocal(instant, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return {
    date: p.year + "-" + p.month + "-" + p.day,
    time: p.hour + ":" + p.minute,
  };
}
