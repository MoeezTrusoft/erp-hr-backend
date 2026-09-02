// scripts/attendance-deduction-dryrun.js
//
// What the attendance deduction rules WOULD cost. Read-only: it computes and
// prints, and writes nothing to any table.
//
// It reports every rule as if it were enabled, whatever its stored `enabled`
// flag says. That is the point — all five ship disabled, so a run that honoured
// the flag would print zeroes and tell you nothing. The output is a forecast,
// clearly labelled, not a statement of what is being charged.
//
//   node scripts/attendance-deduction-dryrun.js --from 2026-08-01 --to 2026-08-31
//   node scripts/attendance-deduction-dryrun.js ... --grace 15
//   node scripts/attendance-deduction-dryrun.js ... --top 15
//
// HR-ATT-POLICY-01.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { replayTenant, tenantsWithPunches, dayKey } from "../src/lib/attendanceReplay.js";
import { getAttendancePolicy } from "../src/services/attendancePolicyConfig.service.js";
import { listDeductionRules } from "../src/services/attendanceDeductionRule.service.js";
import { listDisapprovedLeaveDays } from "../src/services/disapprovedLeave.service.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM = arg("from", "2026-08-01");
const TO = arg("to", "2026-08-31");
const TOP = Number(arg("top", "10"));

const RULE_KEYS = ["DISAPPROVED_LEAVE", "LATE", "MISSING_CHECKIN", "MISSING_CHECKOUT", "EARLY_CHECKOUT"];

/** N occurrences cost X days, capped. floor() so a partial group costs nothing. */
function applyRule(rule, occurrences) {
  if (!occurrences) return 0;
  const groups = Math.floor(occurrences / Math.max(rule.triggerCount, 1));
  let days = groups * rule.deductionDays;
  if (rule.maxDeductionDaysPerPeriod != null) {
    days = Math.min(days, rule.maxDeductionDaysPerPeriod);
  }
  return days;
}

async function main() {
  const tenantIds = await tenantsWithPunches(mcpCtx);

  const grand = { byRule: new Map(), employees: new Map(), tenants: [] };
  for (const k of RULE_KEYS) grand.byRule.set(k, { occurrences: 0, employees: new Set(), days: 0 });

  for (const tenantId of tenantIds) {
    await mcpCtx.run({ user: { tenantId } }, async () => {
      const stored = await getAttendancePolicy({ tenantId });
      const policy = {
        ...stored,
        ...(arg("grace") != null ? { graceMinutes: Number(arg("grace")) } : {}),
      };

      const [rules, shifts, disapprovedDays, employees] = await Promise.all([
        listDeductionRules({ tenantId }),
        replayTenant({ tenantId, from: FROM, to: TO, policy }),
        listDisapprovedLeaveDays({ tenantId, from: FROM, to: TO }),
        prisma.employee.findMany({ select: { id: true, employee_code: true, employee_name: true, first_name: true, last_name: true } }),
      ]);

      const nameOf = new Map(
        employees.map((e) => [
          e.id,
          e.employee_name || [e.first_name, e.last_name].filter(Boolean).join(" ") || e.employee_code || `#${e.id}`,
        ]),
      );
      const ruleByKey = new Map(rules.map((r) => [r.ruleKey, r]));

      // Occurrences per employee per rule. Counted DISTINCT by day where the
      // underlying thing is a day, so one bad day cannot be billed twice.
      const perEmployee = new Map();
      const bump = (employeeId, key, day) => {
        if (!perEmployee.has(employeeId)) perEmployee.set(employeeId, new Map());
        const m = perEmployee.get(employeeId);
        if (!m.has(key)) m.set(key, new Set());
        m.get(key).add(dayKey(day));
      };

      for (const { employeeId, day, verdict } of shifts) {
        if (verdict.status === "LATE") bump(employeeId, "LATE", day);
        if (verdict.status === "MISSING_CHECKIN") bump(employeeId, "MISSING_CHECKIN", day);
        if (verdict.status === "MISSING_CHECKOUT") bump(employeeId, "MISSING_CHECKOUT", day);
        if (verdict.anomalies?.some((a) => a.type === "EARLY_CHECKOUT")) {
          bump(employeeId, "EARLY_CHECKOUT", day);
        }
      }
      for (const d of disapprovedDays) bump(d.employeeId, "DISAPPROVED_LEAVE", d.date);

      const tenantSummary = { tenantId, byRule: new Map(), totalDays: 0, employees: perEmployee.size };
      for (const k of RULE_KEYS) tenantSummary.byRule.set(k, { occurrences: 0, employees: 0, days: 0 });

      for (const [employeeId, counts] of perEmployee) {
        let employeeDays = 0;
        const detail = [];
        for (const key of RULE_KEYS) {
          const occ = counts.get(key)?.size ?? 0;
          if (!occ) continue;
          const rule = ruleByKey.get(key);
          const days = applyRule(rule, occ);

          const t = tenantSummary.byRule.get(key);
          t.occurrences += occ;
          t.employees += 1;
          t.days += days;

          const g = grand.byRule.get(key);
          g.occurrences += occ;
          g.employees.add(`${tenantId}:${employeeId}`);
          g.days += days;

          employeeDays += days;
          if (days > 0) detail.push(`${key}x${occ}=${days}d`);
        }
        tenantSummary.totalDays += employeeDays;
        if (employeeDays > 0) {
          grand.employees.set(`${tenantId}:${employeeId}`, {
            name: nameOf.get(employeeId) ?? `#${employeeId}`,
            tenant: tenantId.slice(0, 8),
            days: employeeDays,
            detail: detail.join(" "),
          });
        }
      }

      grand.tenants.push({ ...tenantSummary, enabled: rules.filter((r) => r.enabled).map((r) => r.ruleKey) });
    });
  }

  console.log(`\n=== DEDUCTION DRY RUN ${FROM} .. ${TO} ===`);
  console.log(`FORECAST ONLY — nothing was written, and every rule is currently DISABLED.`);
  console.log(`Figures show what each rule WOULD cost at its configured N and X.\n`);

  console.log(`--- per rule (all tenants) ---`);
  console.log(`  ${"rule".padEnd(20)} ${"occurrences".padStart(12)} ${"employees".padStart(10)} ${"days".padStart(8)}`);
  let grandDays = 0;
  for (const key of RULE_KEYS) {
    const g = grand.byRule.get(key);
    grandDays += g.days;
    console.log(
      `  ${key.padEnd(20)} ${String(g.occurrences).padStart(12)} ${String(g.employees.size).padStart(10)} ${g.days.toFixed(1).padStart(8)}`,
    );
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${"".padStart(12)} ${"".padStart(10)} ${grandDays.toFixed(1).padStart(8)}`);

  console.log(`\n--- per tenant, per rule (occurrences / employees / days) ---`);
  for (const t of grand.tenants) {
    console.log(
      `  ${t.tenantId.slice(0, 8)}  employees ${String(t.employees).padStart(3)}  total days ${t.totalDays.toFixed(1).padStart(7)}` +
      `  enabled: ${t.enabled.length ? t.enabled.join(",") : "none"}`,
    );
    for (const key of RULE_KEYS) {
      const r = t.byRule.get(key);
      if (!r.occurrences) continue;
      console.log(
        `      ${key.padEnd(20)} occ ${String(r.occurrences).padStart(4)}` +
        `  emp ${String(r.employees).padStart(3)}  days ${r.days.toFixed(1).padStart(6)}`,
      );
    }
  }

  const worst = [...grand.employees.values()].sort((a, b) => b.days - a.days).slice(0, TOP);
  if (worst.length) {
    console.log(`\n--- worst affected employees (top ${TOP}) ---`);
    for (const e of worst) {
      console.log(`  ${e.tenant} ${e.name.padEnd(24)} ${e.days.toFixed(1).padStart(6)} days   ${e.detail}`);
    }
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
