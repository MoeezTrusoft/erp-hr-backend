// RFC 5545 calendar snapshot. No attendee addresses or status-link credentials.
import { createHash } from "node:crypto";
const text = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .split("")
    .filter(
      (c) => c === "\t" || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
    )
    .join("");
const date = (value) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
function fold(line) {
  let out = "",
    length = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (length + size > 75) {
      out += "\r\n ";
      length = 1;
    }
    out += char;
    length += size;
  }
  return out;
}
export function interviewCalendarFile(interview) {
  const uid =
    createHash("sha256")
      .update(interview.tenantId + ":" + interview.id)
      .digest("hex") + "@recruitment.trusoft.ai";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TruSoft//Recruitment//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    "UID:" + uid,
    "DTSTAMP:" + date(interview.updated_at),
    "LAST-MODIFIED:" + date(interview.updated_at),
    "DTSTART:" + date(interview.scheduledAt),
    "DTEND:" +
      date(
        +new Date(interview.scheduledAt) + interview.durationMinutes * 60000,
      ),
    "SEQUENCE:" + interview.sequence,
    "STATUS:" + (interview.status === "CANCELLED" ? "CANCELLED" : "CONFIRMED"),
    "CLASS:PRIVATE",
    "SUMMARY:" + text("Interview: " + interview.jobTitle),
    "LOCATION:" + text(interview.location),
    "DESCRIPTION:" +
      text(
        "Interview for " +
          interview.jobTitle +
          ". Manage your schedule through your private careers status page.",
      ),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
