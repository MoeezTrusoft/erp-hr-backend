// src/lib/attendanceDeduction.js
//
// The attendance-deduction rules, as pure functions. No database, no clock of
// its own, no imports — everything arrives as arguments, exactly like
// attendanceEvaluator.js next door. That is deliberate for the same reason: this
// decides how much salary is withheld, and money-adjacent logic that can only be
// exercised against a provisioned Postgres is logic nobody checks.
//
// Two halves, because they fail differently:
//
//   1. countViolationDays — stored rows → countable occurrences. The hard part
//      is what does NOT count: a day HR corrected by hand, a day excused by an
//      approved anomaly, and the same day arriving twice.
//   2. computeAttendanceDeductions — occurrences + rules → deduction DAYS.
//      "N occurrences cost X days", pooled by counterGroup, capped.
//
// Days are the output on purpose. Converting days to money belongs to the
// payslip engine, which already owns the daily rate (baseMinor / workingDays)
// for LWP; a second daily-rate formula living here is how a payslip ends up
// computing one concept two ways.
//
// HR-ATT-PAYROLL-BRIDGE-01.

/** Calendar day of a Date/ISO value, as a stable string key. */
const dayKey = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// The stored daily verdict maps 1:1 onto a rule key. HALF_DAY and ABSENT are
// absent from this table on purpose: they are already priced through
// Attendance.day_credit, so charging them here as well would dock the day twice.
const STATUS_TO_RULE = {
  LATE: "LATE",
  MISSING_CHECKIN: "MISSING_CHECKIN",
  MISSING_CHECKOUT: "MISSING_CHECKOUT",
};

// Anomaly types that map onto a deduction rule. EARLY_CHECKOUT exists ONLY as
// an anomaly type (AnomalyType enum) — there is no attendance status for it (a
// full-credit day with an early departure is PRESENT), so the EARLY_CHECKOUT
// anomaly record is the ONLY evidence an early departure happened. HR's
// register charges it unless the appeal was APPROVED, so PENDING and REJECTED
// both count. LATE/MISSING anomalies are NOT added here: the day's own status
// (LATE / MISSING_*) already feeds those rules, and an APPROVED appeal excuses
// the whole day via the excused set below.
const ANOMALY_TO_RULE = {
  EARLY_CHECKOUT: "EARLY_CHECKOUT",
};

/**
 * Countable violations for ONE employee over ONE period.
 *
 * @param {object[]} attendance  Attendance rows: { date, status, manually_corrected }
 * @param {object[]} anomalies   AttendanceAnomaly rows: { date, status }
 * @returns {{ruleKey: string, day: string}[]} distinct (rule, day) pairs, sorted
 */
export function countViolationDays({ attendance = [], anomalies = [] } = {}) {
  // An APPROVED anomaly is HR agreeing the day was not the employee's fault.
  // It excuses the WHOLE day, whatever the day's stored status says — the
  // anomaly types (LATE_CHECKIN, MISSING_*, EARLY_CHECKOUT) do not line up with
  // the rule keys one-for-one, and a per-type match would let a day excused as
  // "device was down" still be billed under a different key.
  const excused = new Set();
  for (const a of anomalies) {
    if (a?.status !== "APPROVED") continue;
    const key = dayKey(a.date);
    if (key) excused.add(key);
  }

  const seen = new Set();
  const creditLossDays = new Set();
  const add = (ruleKey, day) => {
    if (!day || excused.has(day)) return;
    seen.add(`${ruleKey}|${day}`);
  };

  // ABSENT/HALF_DAY are priced from Attendance.day_credit by the payslip
  // bridge. Keep their day keys here so an EARLY_CHECKOUT anomaly on the same
  // row is not also emitted as a rule violation and charged twice. If the
  // employee worked a full-credit day, EARLY_CHECKOUT remains rule-priced.
  for (const row of attendance) {
    const day = dayKey(row?.date);
    if (!day || row?.manually_corrected || excused.has(day)) continue;
    if (row?.status === "ABSENT" || row?.status === "HALF_DAY") creditLossDays.add(day);
  }

  for (const row of attendance) {
    // HR's ruling outranks the device — the same precedence the roll-up uses
    // (attendanceWriter.service.js). A corrected day has already been priced by
    // whoever corrected it.
    if (row?.manually_corrected) continue;
    const ruleKey = STATUS_TO_RULE[row?.status];
    if (ruleKey) add(ruleKey, dayKey(row.date));
  }

  // A refused explanation only becomes DISAPPROVED_LEAVE when what was being
  // explained is an ABSENCE — the person did not work and the excuse was
  // refused, so the day is unpaid.
  //
  // Refusing any OTHER kind of appeal does NOT cost a day. The underlying
  // violation already has its own rule: a refused LATE_CHECKIN appeal leaves the
  // day LATE and the LATE rule counts it; a refused MISSING_CHECKOUT appeal
  // leaves the day MISSING_CHECKOUT for the MISSING_PUNCH rule.
  //
  // This previously charged EVERY rejected anomaly as a full day of leave. One
  // employee worked a full day, arrived at 20:45, appealed the lateness, lost —
  // and was charged 16,129 (a whole day of a 500k salary) on top of the lateness
  // that was already being counted. Eight of the thirteen rejected appeals in
  // August were LATE_CHECKIN, so most of this rule's charge was that mistake.
  for (const a of anomalies) {
    if (a?.status === "REJECTED" && a?.type === "ABSENT") {
      add("DISAPPROVED_LEAVE", dayKey(a.date));
      continue;
    }
    // EARLY_CHECKOUT (see ANOMALY_TO_RULE): the anomaly is the only record of
    // the violation, so it counts unless HR approved the appeal. The add()
    // dedupes with any same-day status-derived violation.
    const ruleKey = a?.status !== "APPROVED" ? ANOMALY_TO_RULE[a?.type] : null;
    const day = dayKey(a.date);
    if (ruleKey === "EARLY_CHECKOUT" && creditLossDays.has(day)) continue;
    if (ruleKey) add(ruleKey, day);
  }

  return [...seen]
    .sort()
    .map((k) => {
      const [ruleKey, day] = k.split("|");
      return { ruleKey, day };
    });
}

/**
 * Price the violations against the configured rules.
 *
 * Rules sharing a counterGroup are scored as ONE counter: their DAYS are pooled
 * before N is applied, so two missed check-ins and one missed check-out is three
 * occurrences of MISSED_PUNCH rather than two sub-threshold counts that cost
 * nothing. Pooling by day (not by occurrence) means a single calendar day that
 * trips two rules in the group is still one occurrence.
 *
 * @param {object[]} violations  from countViolationDays
 * @param {object[]} rules       AttendanceDeductionRule rows, in a stable order
 * @returns {{ruleKey, counterGroup, occurrences, days}[]} only lines that cost
 *          something, in `rules` order — the payslip must be byte-stable.
 */
export function computeAttendanceDeductions({ violations = [], rules = [] } = {}) {
  const enabled = rules.filter((r) => r?.enabled);
  const byKey = new Map(enabled.map((r) => [r.ruleKey, r]));

  const daysByKey = new Map();
  for (const v of violations) {
    if (!byKey.has(v?.ruleKey)) continue; // no rule configured/enabled for it
    if (!daysByKey.has(v.ruleKey)) daysByKey.set(v.ruleKey, new Set());
    daysByKey.get(v.ruleKey).add(v.day);
  }

  // group → { days: Set, firstKey } — the group is scored once, under the first
  // contributing rule in `rules` order, so the emitted line is deterministic.
  const pools = new Map();
  for (const r of enabled) {
    const days = daysByKey.get(r.ruleKey);
    if (!days?.size) continue;
    const group = r.counterGroup || r.ruleKey;
    if (!pools.has(group)) pools.set(group, { days: new Set(), rule: r });
    for (const d of days) pools.get(group).days.add(d);
  }

  const lines = [];
  for (const { days, rule } of pools.values()) {
    const occurrences = days.size;
    // floor(): a partial group costs nothing. Half of "3 lates = 1 day" is not
    // a third of a day, it is not yet a violation.
    const triggered = Math.floor(occurrences / Math.max(rule.triggerCount || 1, 1));
    let deductionDays = triggered * (rule.deductionDays || 0);
    if (rule.maxDeductionDaysPerPeriod != null) {
      deductionDays = Math.min(deductionDays, rule.maxDeductionDaysPerPeriod);
    }
    const trigger = Math.max(rule.triggerCount || 1, 1);
    // D1 (operator law 2026-09-11): HR pools violation occurrences across
    // categories and floors the GRAND TOTAL once — "2 days late = 0, 5 days
    // late = 1". The engine's per-group floor can't express "1.33 → pooled".
    // `rawDays` is the UNFLOORED fractional day value (occurrences ÷ trigger ×
    // deductionDays) for engines in POOLED_FLOOR mode; legacy consumers use
    // `days` (per-group floored) and ignore it.
    // A group whose OWN floor is 0 still surfaces (rawDays > 0) so pooled
    // engines can add it to the grand total — Zubair's "2 lates + 1 early = 1
    // day" dies if the 2 lates are dropped here. Legacy consumers filter on
    // days <= 0, so a days:0 line changes nothing for them.
    const rawDays = Math.round(((occurrences / trigger) * (rule.deductionDays || 0)) * 100) / 100;
    if (deductionDays <= 0 && rawDays <= 0) continue;
    lines.push({
      ruleKey: rule.ruleKey,
      counterGroup: rule.counterGroup ?? null,
      occurrences,
      rawDays,
      // Float arithmetic on 0.5-day steps: round to 2dp so 3 × 0.1 cannot leak
      // 0.30000000000000004 into a money line.
      days: Math.round(deductionDays * 100) / 100,
    });
  }
  return lines;
}
