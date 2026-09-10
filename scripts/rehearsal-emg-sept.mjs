// scripts/rehearsal-emg-sept.mjs — September rehearsal (plan 20 T-2.6, Phase 2)
//
// Dry-run of the EMG September payroll from READ-ONLY production exports
// (audit-reports/baselines/2026-09-rehearsal/*.csv). No database, no writes:
// this replays the exported attendance through the REAL rule engine
// (src/lib/attendanceDeduction.js) and mirrors the T-1.1 ABSENCE_RECOVERY
// credit-loss pricing (payrollService.js step 7c) to show the flag OFF vs ON
// delta before HR signs anything.
//
// Salaries: employment_terms.baseSalary is C4 ciphertext at rest (by design),
// so the basis comes from the August payslip BASE_SALARY line — the same
// figure the engine would recompute for an unchanged config.
//
// Usage: node scripts/rehearsal-emg-sept.mjs [baselineDir]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countViolationDays, computeAttendanceDeductions } from '../src/lib/attendanceDeduction.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || join(__dirname, '..', '..', 'audit-reports', 'baselines', '2026-09-rehearsal');

// ---------- tiny CSV ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length > 1 || r[0] !== '').map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const load = (name) => parseCsv(readFileSync(join(BASE, name), 'utf8'));

// ---------- exact integer money (matches src/lib/money.js semantics) ----------
// Decimal string with up to 4dp → minor units (2dp) BigInt, truncating the
// sub-minor remainder exactly like the engine's storage round-trip.
function decToMinor(s) {
  const [int, frac = ''] = String(s).trim().replace(/^-/, m => m).split('.');
  const sign = String(s).trim().startsWith('-') ? -1n : 1n;
  const f4 = (frac + '0000').slice(0, 4);
  const minor4 = BigInt(int || '0') * 10000n + BigInt(f4);
  // minor(2dp) = floor(minor4 / 100) — engine truncates at the paisa boundary
  return sign * (minor4 / 100n);
}

// daysToMinor mirror: basis × (days×100) / (periodDays×100), truncated.
function daysToMinor(basisMinor, dayHundredths, periodDays) {
  return (basisMinor * dayHundredths) / (BigInt(periodDays) * 100n);
}

// ---------- load ----------
const employees = load('emg-employees.csv').filter(e => e.status === 'Active');
const attendance = load('emg-attendance-sept.csv').map(a => ({
  employeeId: a.employeeId,
  date: a.date,
  status: a.status,
  day_credit: a.day_credit === '' ? null : Number(a.day_credit),
}));
const anomalies = load('emg-anomalies-sept.csv').map(a => ({ employeeId: a.employeeId, date: a.date, type: a.type, status: a.status }));
const rules = load('emg-deduction-rules.csv').map(r => ({
  ruleKey: r.ruleKey,
  counterGroup: r.counterGroup || null,
  triggerCount: Number(r.triggerCount),
  deductionDays: Number(r.deductionDays),
  maxDeductionDaysPerPeriod: r.maxDeductionDaysPerPeriod === '' ? null : Number(r.maxDeductionDaysPerPeriod),
  enabled: r.enabled === 't',
}));
const augEarnings = load('emg-august-earnings.csv');
const augSlips = load('emg-august-payslips.csv');

const PERIOD_DAYS = 30; // September: 30 calendar days

// Basis from August GROSS (base + fixed allowances) — matches the PUBLISHED
// deductionBasis=GROSS (doc 22 execution 2026-09-10: PayrollRuleConfig row v1).
// The engine charges the contracted package (contractualMinor), and August
// earning lines are exactly BASE_SALARY + 4 fixed allowances, so the sum of all
// earning lines per employee IS the contractual gross.
const basisByEmp = new Map();
const grossByEmp = new Map();
for (const e of augEarnings) {
  const minor = decToMinor(e.amount);
  if (!basisByEmp.has(e.employeeId)) basisByEmp.set(e.employeeId, 0n);
  basisByEmp.set(e.employeeId, basisByEmp.get(e.employeeId) + minor);
  grossByEmp.set(e.employeeId, (grossByEmp.get(e.employeeId) || 0n) + minor);
}

// ---------- engine replay ----------
const report = [];
for (const emp of employees) {
  const id = emp.id;
  const basisMinor = basisByEmp.get(id);
  if (basisMinor == null) { report.push({ id, name: `${emp.first_name} ${emp.last_name}`, error: 'no August BASE_SALARY line' }); continue; }

  const attRows = attendance.filter(a => a.employeeId === id).map(a => ({
    date: a.date, status: a.status, day_credit: a.day_credit, manually_corrected: false,
  }));
  const anomalyRows = anomalies.filter(a => a.employeeId === id);

  // Rules bridge — the REAL engine functions.
  const violations = countViolationDays({ attendance: attRows, anomalies: anomalyRows });
  const ruleLines = computeAttendanceDeductions({ violations, rules });

  // T-1.1 mirror — step 7c credit loss (flag ON only).
  const excusedDays = new Set(anomalyRows.filter(a => a.status === 'APPROVED').map(a => String(a.date).slice(0, 10)));
  let unpaidHundredths = 0n;
  const creditDetail = { PRESENT: 0, LATE: 0, HALF_DAY: 0, ABSENT: 0, held: 0 };
  for (const row of attRows) {
    if (row.day_credit == null) { creditDetail.held++; continue; }
    const credit = Number(row.day_credit);
    if (!Number.isFinite(credit) || credit < 0 || credit > 1) continue;
    creditDetail[row.status] = (creditDetail[row.status] || 0) + 1;
    const lost = 100n - BigInt(Math.round(credit * 100));
    if (lost > 0n && !excusedDays.has(String(row.date).slice(0, 10))) unpaidHundredths += lost;
  }

  const ruleDaysHundredths = ruleLines.reduce((acc, l) => acc + BigInt(Math.round(l.days * 100)), 0n);
  const ruleMinor = daysToMinor(basisMinor, ruleDaysHundredths, PERIOD_DAYS);
  const absenceMinor = daysToMinor(basisMinor, unpaidHundredths, PERIOD_DAYS);

  report.push({
    id,
    name: `${emp.first_name} ${emp.last_name}`,
    basisMinor,
    grossMinor: grossByEmp.get(id) ?? basisMinor,
    daysRecorded: attRows.length,
    creditDetail,
    ruleLines,
    ruleDays: Number(ruleDaysHundredths) / 100,
    ruleMinor,
    absenceDays: Number(unpaidHundredths) / 100,
    absenceMinor,
    deltaMinor: absenceMinor, // flag ON adds exactly this
  });
}

// ---------- render ----------
const fmt = (minor) => {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(3, '0');
  return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`;
};

const lines = [];
lines.push('# EMG September Rehearsal — dry run (no writes, no DB)');
lines.push('');
lines.push(`Source: ${BASE} (read-only prod exports) · period days: ${PERIOD_DAYS} · basis: August GROSS (base + fixed allowances) — published deductionBasis=GROSS`);
lines.push('');
lines.push('| Emp | Basis (PKR) | Days rec | LATE/MISS rule days | Rule deduction | Absence days (credit loss) | ABSENCE_RECOVERY (flag ON) |');
lines.push('|---|---|---|---|---|---|---|');
let totRule = 0n, totAbs = 0n;
for (const r of report) {
  if (r.error) { lines.push(`| ${r.id} ${r.name} | — | — | — | — | — | ERROR: ${r.error} |`); continue; }
  totRule += r.ruleMinor; totAbs += r.absenceMinor;
  const ruleDetail = r.ruleLines.map(l => `${l.ruleKey}:${l.days}d`).join(' ') || '—';
  lines.push(`| ${r.id} ${r.name} | ${fmt(r.basisMinor)} | ${r.daysRecorded} | ${ruleDetail} | ${fmt(r.ruleMinor)} | ${r.absenceDays || '—'} | ${fmt(r.absenceMinor)} |`);
}
lines.push('');
lines.push(`**Flag OFF rule deductions total:** PKR ${fmt(totRule)}`);
lines.push('');
lines.push(`**Flag ON extra (ABSENCE_RECOVERY) total:** PKR ${fmt(totAbs)}`);
lines.push('');
lines.push(`**Combined exposure flag ON:** PKR ${fmt(totRule + totAbs)} (per full-month run at today's data; the run happens month-end so more days will accrue)`);
lines.push('');
lines.push('## Per-employee credit detail');
lines.push('');
lines.push('| Emp | PRESENT | LATE | HALF_DAY | ABSENT | held(NULL) |');
lines.push('|---|---|---|---|---|---|');
for (const r of report) {
  if (r.error) continue;
  const c = r.creditDetail;
  lines.push(`| ${r.id} ${r.name} | ${c.PRESENT || 0} | ${c.LATE || 0} | ${c.HALF_DAY || 0} | ${c.ABSENT || 0} | ${c.held || 0} |`);
}
const out = lines.join('\n');
console.log(out);
writeFileSync(join(BASE, 'rehearsal-result.md'), out + '\n');
console.log('\nwritten:', join(BASE, 'rehearsal-result.md'));
