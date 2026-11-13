// T15: "today" for holiday rules is the calendar date in the company's time zone, not the server's.
// Holidays are stored as UTC-midnight dates, so the result is a UTC-midnight Date for that civil day.
// shortcut: defaults to Asia/Karachi (every company today); pass the tenant's attendance time zone when a
// company in another zone is onboarded.
export const DEFAULT_HOLIDAY_ZONE = "Asia/Karachi";

export function todayInZone(now = new Date(), timeZone = DEFAULT_HOLIDAY_ZONE) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  return new Date(`${ymd}T00:00:00.000Z`);
}
