// Attendance Anomaly Rules, supplied 2026-10-12. Facts and financial decisions
// are separate: only a management-disapproved, still-applicable case is priced.
export const ANOMALY_RULE_VERSION = 2;
export const RULE_TYPES = [
  "MISSING_CHECKIN",
  "MISSING_CHECKOUT",
  "ABSENT",
  "LATE_CHECKIN",
  "EARLY_CHECKOUT",
];
const keyDate = (value) => new Date(value).toISOString().slice(0, 10);
export function resolveGrace(rules = [], context = {}) {
  const levels = [
    ["SHIFT", context.shiftKey],
    ["EMPLOYEE", String(context.employeeId)],
    ["TEAM", context.teamKey],
    ["DEPARTMENT", context.departmentKey],
    ["COMPANY", "*"],
  ];
  const result = { checkInMinutes: 0, checkOutMinutes: 0, sources: {} };
  for (const field of ["checkInMinutes", "checkOutMinutes"]) {
    for (const [scope, scopeKey] of levels) {
      if (!scopeKey) continue;
      const row = rules
        .filter(
          (r) =>
            r.scope === scope &&
            r.scopeKey === scopeKey &&
            keyDate(r.effectiveFrom) <= keyDate(context.date),
        )
        .sort(
          (a, b) =>
            +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom) ||
            (b.version || 0) - (a.version || 0),
        )[0];
      if (row?.[field] == null) continue;
      result[field] = Number(row[field]);
      result.sources[field] = {
        scope,
        scopeKey,
        id: row.id,
        effectiveFrom: row.effectiveFrom,
        version: row.version,
      };
      break;
    }
  }
  return result;
}
export function shiftRuleKey(info = {}) {
  return String(
    info.pattern?.graceKey ||
      (info.shift?.start && info.shift?.end
        ? `${new Date(info.shift.start).toISOString().slice(11, 16)}-${new Date(info.shift.end).toISOString().slice(11, 16)}`
        : "UNASSIGNED"),
  );
}
// Published legacy settings remain attributable defaults during adoption. Any
// dated rule at the same scope replaces the default, including null/inherit.
export function legacyGraceDefaults(config, info, employeeId) {
  const profile = config?.settings?.profiles?.find(
    (p) => p.id === info.profile?.profileId,
  );
  const row = (scope, scopeKey, policy) => ({
    scope,
    scopeKey,
    effectiveFrom: "0001-01-01",
    id: `published-setup:${config?.version}:${scopeKey}`,
    version: config?.version,
    checkInMinutes: policy?.graceMinutes ?? null,
    checkOutMinutes: policy?.earlyLeaveGraceMin ?? null,
  });
  return [
    row("COMPANY", "*", config?.policy),
    row("EMPLOYEE", String(employeeId), profile?.policy),
  ];
}
export function anomalyFacts({
  checkIn,
  checkOut,
  shift = {},
  grace = {},
  closed = true,
}) {
  const facts = [];
  const add = (type, expectedTime, actualTime, minutes = null) =>
    facts.push({
      type,
      expectedTime: expectedTime || null,
      actualTime: actualTime || null,
      minutes,
      severity: minutes == null ? null : minutes > 30 ? "MAJOR" : "MINOR",
    });
  if (closed) {
    if (!checkIn && !checkOut) add("ABSENT", shift.start, null);
    else if (!checkIn) add("MISSING_CHECKIN", shift.start, null);
    else if (!checkOut) add("MISSING_CHECKOUT", shift.end, null);
  }
  // Exact elapsed time: grace and the 30-minute threshold have separate purposes.
  const late =
    checkIn && shift.start
      ? (+new Date(checkIn) - +new Date(shift.start)) / 60000
      : 0;
  const early =
    checkOut && shift.end
      ? (+new Date(shift.end) - +new Date(checkOut)) / 60000
      : 0;
  if (late > (grace.checkInMinutes ?? 0))
    add("LATE_CHECKIN", shift.start, checkIn, late);
  if (early > (grace.checkOutMinutes ?? 0))
    add("EARLY_CHECKOUT", shift.end, checkOut, early);
  return facts;
}
export function applyAnomalyRules(result, { shift = {}, policy = {} } = {}) {
  if (result.status === "PUNCH_CONFLICT") return result;
  const grace = policy.resolvedGrace || {
    checkInMinutes: policy.graceMinutes ?? 0,
    checkOutMinutes: policy.earlyLeaveGraceMin ?? 0,
  };
  const anomalies = anomalyFacts({
    checkIn: result.checkIn,
    checkOut: result.checkOut,
    shift,
    grace,
    closed: !result.inProgress,
  });
  const status = [
    "ABSENT",
    "MISSING_CHECKIN",
    "MISSING_CHECKOUT",
    "EARLY_CHECKOUT",
    "LATE_CHECKIN",
  ].find((type) => anomalies.some((a) => a.type === type));
  return {
    ...result,
    rulesVersion: ANOMALY_RULE_VERSION,
    anomalies,
    status:
      status === "LATE_CHECKIN"
        ? "LATE"
        : status ||
          (result.inProgress && !result.checkIn
            ? "PENDING_ATTENDANCE"
            : "PRESENT"),
    // Credit is a review-state indicator, never an automatic salary deduction.
    dayCredit: result.inProgress || anomalies.length ? null : 1,
    processingState: result.inProgress
      ? "OPEN"
      : anomalies.length
        ? "NEEDS_REVIEW"
        : "FINALIZED",
    requiresRegularization: anomalies.length > 0,
  };
}
export function ruleDeductions(anomalies = [], { from, to } = {}) {
  const seen = new Set(),
    lines = [],
    minors = [];
  for (const a of [...anomalies].sort(
    (a, b) => +new Date(a.date) - +new Date(b.date) || a.id - b.id,
  )) {
    if (
      a.rulesVersion !== 2 ||
      a.status !== "REJECTED" ||
      a.evidenceState !== "ACTIVE" ||
      a.decisionRole !== "Management"
    )
      continue;
    if (
      (from && keyDate(a.date) < keyDate(from)) ||
      (to && keyDate(a.date) > keyDate(to))
    )
      continue;
    const key = `${a.employeeId}|${keyDate(a.date)}|${a.sessionKey}|${a.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (a.type === "ABSENT")
      lines.push({ anomalyIds: [a.id], days: 1, date: keyDate(a.date) });
    else if (["MISSING_CHECKIN", "MISSING_CHECKOUT"].includes(a.type))
      lines.push({ anomalyIds: [a.id], days: 0.5, date: keyDate(a.date) });
    else if (["LATE_CHECKIN", "EARLY_CHECKOUT"].includes(a.type)) {
      const minutes =
        a.measuredMinutes ??
        ((a.type === "LATE_CHECKIN" ? 1 : -1) *
          (+new Date(a.actualTime) - +new Date(a.expectedTime))) /
          60000;
      if (!Number.isFinite(Number(minutes)) || minutes <= 0)
        throw new Error(
          "Timing evidence is required before pricing an anomaly",
        );
      if (minutes > 30)
        lines.push({ anomalyIds: [a.id], days: 0.5, date: keyDate(a.date) });
      else minors.push(a);
    }
  }
  // Pool per employee; callers may also use this helper for a whole-site preview.
  const employees = [...new Set(minors.map((a) => a.employeeId))];
  let remainder = 0;
  for (const id of employees) {
    const own = minors.filter((a) => a.employeeId === id);
    for (let i = 0; i + 2 < own.length; i += 3)
      lines.push({
        anomalyIds: own.slice(i, i + 3).map((a) => a.id),
        days: 1,
        date: keyDate(own[i + 2].date),
        pooled: true,
      });
    remainder += own.length % 3;
  }
  return {
    days: lines.reduce((sum, line) => sum + line.days, 0),
    minorCount: minors.length,
    minorRemainder: remainder,
    lines,
  };
}
export const roleNames = (user) =>
  (user?.roles || []).map((r) =>
    String(typeof r === "string" ? r : r.name || r.role || "")
      .trim()
      .toLowerCase(),
  );
export const isManagement = (user) => roleNames(user).includes("management");
export const isAttendanceHr = (user) =>
  isManagement(user) ||
  roleNames(user).some((r) =>
    ["hr", "hr manager", "hr admin", "human resources"].includes(r),
  );
