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
// The deduction rules payroll prices anomalies with. DEFAULT_DEDUCTION_RULES are
// the values that were hard-coded here before they became configurable, so a
// tenant that has not changed anything is priced exactly as before.
//   • A late arrival / early departure longer than majorThresholdMinutes is a
//     MAJOR case and is priced on its own (majorTimingDays).
//   • Shorter ones are MINOR: every `poolSize` of them, per employee, within the
//     payroll period being priced, cost pooledMinorDays. The pool is per period:
//     leftovers do not carry into the next period.
export const DEFAULT_DEDUCTION_RULES = Object.freeze({
  majorThresholdMinutes: 30,
  poolSize: 3,
  absentDays: 1,
  missingPunchDays: 0.5,
  majorTimingDays: 0.5,
  pooledMinorDays: 1,
});
const POLICY_RULE_FIELDS = {
  majorThresholdMinutes: "deductMajorThresholdMinutes",
  poolSize: "deductPoolSize",
  absentDays: "deductAbsentDays",
  missingPunchDays: "deductMissingPunchDays",
  majorTimingDays: "deductMajorTimingDays",
  pooledMinorDays: "deductPooledMinorDays",
};
// A tenant's rules from its attendance policy row; any field not set falls back
// to the default. Values outside the editor's limits are ignored, never priced.
export function deductionRulesFromPolicy(policy = {}) {
  const rules = { ...DEFAULT_DEDUCTION_RULES };
  for (const [key, column] of Object.entries(POLICY_RULE_FIELDS)) {
    const value = Number(policy?.[column]);
    if (policy?.[column] == null || !Number.isFinite(value) || value < 0) continue;
    if (key === "poolSize" && (!Number.isInteger(value) || value < 1)) continue;
    rules[key] = value;
  }
  return rules;
}
export function ruleDeductions(anomalies = [], { from, to, rules } = {}) {
  const r = { ...DEFAULT_DEDUCTION_RULES, ...(rules || {}) };
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
      lines.push({ anomalyIds: [a.id], days: r.absentDays, date: keyDate(a.date) });
    else if (["MISSING_CHECKIN", "MISSING_CHECKOUT"].includes(a.type))
      lines.push({ anomalyIds: [a.id], days: r.missingPunchDays, date: keyDate(a.date) });
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
      if (minutes > r.majorThresholdMinutes)
        lines.push({ anomalyIds: [a.id], days: r.majorTimingDays, date: keyDate(a.date) });
      else minors.push(a);
    }
  }
  // Pool per employee; callers may also use this helper for a whole-site preview.
  const employees = [...new Set(minors.map((a) => a.employeeId))];
  let remainder = 0;
  for (const id of employees) {
    const own = minors.filter((a) => a.employeeId === id);
    for (let i = 0; i + r.poolSize <= own.length; i += r.poolSize)
      lines.push({
        anomalyIds: own.slice(i, i + r.poolSize).map((a) => a.id),
        days: r.pooledMinorDays,
        date: keyDate(own[i + r.poolSize - 1].date),
        pooled: true,
      });
    remainder += own.length % r.poolSize;
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
