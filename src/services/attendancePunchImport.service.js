// Historical punch import: a device log file goes through the SAME capture
// pipeline as live punches (receiveCapture -> drain -> evaluation), so each day
// is judged by the attendance setup version and roster in force on that day.
import prisma from "../lib/prisma.js";
import { captureError, MAX_CAPTURE_ROWS } from "../lib/attendanceCapture.js";
import { dayAfter as addDay, daysBetween, importToken, isoDay as iso, parsePunchLog, runs } from "../lib/punchImportParse.js";
import { receiveCapture } from "./attendanceCapture.service.js";
import { mcpCtx } from "../mcp/context.js";

const chunks = (rows) => {
  const out = [];
  for (let i = 0; i < rows.length; i += MAX_CAPTURE_ROWS)
    out.push(rows.slice(i, i + MAX_CAPTURE_ROWS));
  return out;
};

function loadFile({ text, sn }) {
  if (!sn) throw captureError("Choose the device the log came from");
  const parsed = parsePunchLog(text);
  if (!parsed.rows.length)
    throw captureError(parsed.errors[0]?.message || "The file has no punches");
  return parsed;
}

export async function previewPunchImport({ tenantId, sn, text }, db = prisma) {
  const parsed = loadFile({ text, sn });
  const reasons = {};
  const unmatched = new Map();
  let willEvaluate = 0;
  for (const part of chunks(parsed.rows)) {
    const r = await receiveCapture({
      sn,
      rows: part.map((p) => p.raw),
      source: "DEVICE_SYNC",
      tenantId,
      dryRun: true,
    }, db);
    willEvaluate += r.pending;
    for (const issue of r.issues) {
      reasons[issue.reason] = (reasons[issue.reason] || 0) + 1;
      if (issue.reason === "UNKNOWN_IDENTITY")
        unmatched.set(issue.deviceUserId, (unmatched.get(issue.deviceUserId) || 0) + 1);
    }
  }
  return {
    previewToken: importToken(sn, parsed.rows),
    sn,
    punches: parsed.rows.length,
    invalid: parsed.errors.length,
    errors: parsed.errors.slice(0, 50),
    from: parsed.from,
    to: parsed.to,
    distinctIds: parsed.ids.length,
    willEvaluate,
    held: Object.values(reasons).reduce((a, b) => a + b, 0),
    reasons,
    unmatched: [...unmatched].map(([deviceUserId, punches]) => ({ deviceUserId, punches })),
  };
}

export async function commitPunchImport({ tenantId, sn, text, previewToken, reason, actorId }, db = prisma) {
  if (!reason?.trim()) throw captureError("A reason is required to import history");
  const parsed = loadFile({ text, sn });
  if (parsed.errors.length)
    throw captureError("Fix the invalid rows and preview again before importing");
  const token = importToken(sn, parsed.rows);
  if (token !== previewToken)
    throw captureError("The file or device changed since the preview; preview again", 409);
  const total = { received: 0, stored: 0, duplicates: 0, pending: 0, needsReview: 0 };
  let index = 0;
  for (const part of chunks(parsed.rows)) {
    // Stable key per chunk: re-sending the same file resumes safely.
    const r = await receiveCapture({
      sn,
      rows: part.map((p) => p.raw),
      source: "DEVICE_SYNC",
      tenantId,
      actorId,
      requestKey: `punch-import:${token.slice(0, 32)}:${index}`,
      notes: `Historical punch import: ${reason.trim()}`.slice(0, 2000),
    }, db);
    for (const k of Object.keys(total)) total[k] += r[k] || 0;
    index += 1;
  }
  return { ...total, from: parsed.from, to: parsed.to, chunks: index };
}

// What will judge each part of [from, to]: the setup releases in force, the
// stretches with no setup at all, and employees whose roster does not cover days.
export async function periodCoverage({ tenantId, from, to, employeeIds }, db = prisma) {
  if (!(from <= to)) throw captureError("The start date must not be after the end date");
  const days = daysBetween(from, to);
  if (days.length > 800) throw captureError("Choose a period of at most 800 days");
  return mcpCtx.run({ system: true, user: { tenantId } }, async () => {
    const releases = await db.attendanceSetupRelease.findMany({
      where: { tenantId },
      orderBy: [{ effectiveFrom: "asc" }, { version: "asc" }],
      select: { version: true, effectiveFrom: true, coverageThrough: true, reason: true, publishedAt: true },
    });
    // The release that applies on a day is the latest effectiveFrom <= day, as long
    // as the day is inside its coverage.
    const segments = [];
    const uncovered = [];
    for (const day of days) {
      const applicable = releases.filter((r) => iso(r.effectiveFrom) <= day).pop();
      const covered = applicable && iso(applicable.coverageThrough) >= day;
      if (!covered) {
        uncovered.push(day);
        continue;
      }
      const last = segments[segments.length - 1];
      if (last && last.version === applicable.version && addDay(last.to) === day) last.to = day;
      else
        segments.push({
          version: applicable.version,
          from: day,
          to: day,
          reason: applicable.reason,
          publishedAt: applicable.publishedAt,
        });
    }
    const employees = await db.employee.findMany({
      where: {
        tenant_id: tenantId,
        payroll_included: { not: false },
        ...(employeeIds?.length ? { id: { in: employeeIds } } : {}),
      },
      select: { id: true, employee_code: true, first_name: true, last_name: true, hire_date: true },
    });
    const schedules = await db.workSchedule.findMany({
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        effective_start_date: { lte: new Date(`${to}T00:00:00Z`) },
        OR: [{ effective_end_date: null }, { effective_end_date: { gte: new Date(`${from}T00:00:00Z`) } }],
      },
      select: { employeeId: true, effective_start_date: true, effective_end_date: true },
    });
    const byEmployee = new Map();
    for (const s of schedules) {
      if (!byEmployee.has(s.employeeId)) byEmployee.set(s.employeeId, []);
      byEmployee.get(s.employeeId).push(s);
    }
    const rosterGaps = [];
    for (const e of employees) {
      const start = e.hire_date ? iso(e.hire_date) : from;
      const own = byEmployee.get(e.id) || [];
      const missing = days.filter(
        (d) =>
          d >= start &&
          !own.some(
            (s) => iso(s.effective_start_date) <= d && (!s.effective_end_date || iso(s.effective_end_date) >= d),
          ),
      );
      if (missing.length)
        rosterGaps.push({
          employeeId: e.id,
          name: [e.first_name, e.last_name].filter(Boolean).join(" ") || e.employee_code,
          code: e.employee_code,
          days: missing.length,
          ranges: runs(missing).slice(0, 5),
        });
    }
    return {
      from,
      to,
      days: days.length,
      segments,
      noSetup: runs(uncovered),
      employees: employees.length,
      rosterGaps,
    };
  });
}
