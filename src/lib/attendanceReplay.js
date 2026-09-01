// src/lib/attendanceReplay.js
//
// Shared replay core for the two analysis reports: the status shadow-diff and
// the deduction dry-run.
//
// Extracted rather than copied. If the two reports sessionised punches
// separately they could disagree, and the whole point of both is to be believed
// — a status report and a money report that count different shifts are worse
// than no report at all.
//
// Read-only. Nothing here writes.
//
// HR-ATT-POLICY-01.
import prisma from "./prisma.js";
import { evaluateShift } from "./attendanceEvaluator.js";
import { resolveWorkingDays } from "../services/workingDay.service.js";

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;

export const startOfDay = (v) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d; };
export const dayKey = (d) => startOfDay(d).toISOString().slice(0, 10);

/** "HH:MM" anchored to a day; a night shift rolls its end into the next one. */
export function shiftFor(pattern, day) {
  const raw = pattern?.shift;
  const mk = (hhmm) => {
    const m = typeof hhmm === "string" ? hhmm.trim().match(/^(\d{1,2}):(\d{2})/) : null;
    if (!m) return null;
    const d = new Date(day);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  };
  const start = mk(raw?.from);
  let end = mk(raw?.to);
  if (start && end && end <= start) end = new Date(end.getTime() + DAY_MS);
  return { start, end };
}

/**
 * Group punches into shifts on the configured gap — the same 11-hour rule the
 * SQL rebuild used, so every figure produced here is comparable with it.
 */
export function sessionise(punches, gapHours) {
  const gapMs = gapHours * 60 * MIN_MS;
  const sorted = [...punches].sort((a, b) => a.punchedAt - b.punchedAt);
  const sessions = [];
  let current = null;
  for (const p of sorted) {
    if (!current || p.punchedAt - current.last > gapMs) {
      current = { punches: [], last: p.punchedAt };
      sessions.push(current);
    }
    current.punches.push({
      timestamp: p.punchedAt,
      // Direction is deliberately carried through as recorded; the evaluator
      // decides whether to believe it (it does not, by default).
      type: p.status === 0 ? "IN" : p.status === 1 ? "OUT" : "",
    });
    current.last = p.punchedAt;
  }
  return sessions;
}

/**
 * Every evaluated shift for one tenant in a window.
 *
 * Assumes the caller has already established the tenant context; it issues
 * ordinary model queries so RLS scopes them.
 */
export async function replayTenant({ tenantId, from, to, policy, now = new Date() }) {
  const gapHours = policy.shiftGapHours ?? 11;

  const punches = await prisma.attendanceDevicePunch.findMany({
    where: {
      tenantId,
      employeeId: { not: null },
      punchedAt: { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59`) },
    },
    select: { employeeId: true, punchedAt: true, status: true },
    orderBy: [{ employeeId: "asc" }, { punchedAt: "asc" }],
  });

  const byEmployee = new Map();
  for (const p of punches) {
    if (!byEmployee.has(p.employeeId)) byEmployee.set(p.employeeId, []);
    byEmployee.get(p.employeeId).push(p);
  }

  const results = [];

  for (const [employeeId, rows] of byEmployee) {
    const [schedule, working] = await Promise.all([
      prisma.workSchedule.findFirst({
        where: { employeeId },
        orderBy: { effective_start_date: "desc" },
        select: { schedule_pattern: true },
      }),
      resolveWorkingDays({
        employeeId,
        from,
        to: new Date(new Date(to).getTime() + DAY_MS),
      }),
    ]);

    for (const session of sessionise(rows, gapHours)) {
      const day = startOfDay(session.punches[0].timestamp);
      const tomorrow = new Date(day.getTime() + DAY_MS);
      const tomorrowInfo = working.get(dayKey(tomorrow));
      const nextShift = shiftFor(schedule?.schedule_pattern, tomorrow);

      const verdict = evaluateShift({
        punches: session.punches,
        shift: shiftFor(schedule?.schedule_pattern, day),
        policy,
        nextDay: {
          working: Boolean(tomorrowInfo?.working),
          nextShiftStart: tomorrowInfo?.working ? nextShift.start : null,
        },
        now,
      });

      results.push({ employeeId, day, verdict });
    }
  }

  return results;
}

/** Distinct tenants that have punches. See the note in the scripts: this MUST be
 *  a model query under SYSTEM context — $queryRaw skips the RLS extension, sets
 *  no tenant GUC, and silently returns nothing. */
export async function tenantsWithPunches(mcpCtx) {
  const rows = await mcpCtx.run({ system: true }, async () => {
    return await prisma.attendanceDevicePunch.findMany({
      where: { tenantId: { not: null } },
      distinct: ["tenantId"],
      select: { tenantId: true },
    });
  });
  return rows.map((r) => r.tenantId);
}
