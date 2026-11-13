// Phase 6.4 — engine vs HR register comparison.
// Parses /tmp/summary_full.txt (HR's "Attendance Summary for Payroll" dump)
// and joins it to /tmp/aug_reconciliation.csv by fuzzy name match.
import { readFileSync, writeFileSync } from 'node:fs';

const csv = readFileSync('/tmp/aug_reconciliation.csv', 'utf8').trim().split('\n').map((l) => l.split(','));
const hdr = csv.shift();
const col = Object.fromEntries(hdr.map((h, i) => [h, i]));

// HR summary rows: "5 A=1 | B=Ghulam Rasool | C=EMG | E=4 | I=0 | J=1.33 | N=1"
const hr = [];
for (const line of readFileSync('/tmp/summary_full.txt', 'utf8').split('\n')) {
  const fields = {};
  for (const m of line.matchAll(/(?:^|\|)\s*([A-N])=([^|]*)/g)) fields[m[1]] = m[2].trim();
  if (!fields.B || fields.N == null || fields.N === '') continue;
  const num = (v) => (v != null && v !== '' && !isNaN(parseFloat(v)) ? parseFloat(v) : null);
  hr.push({ name: fields.B, dept: fields.C ?? '', absence: num(fields.D), late: num(fields.E), total: num(fields.N) });
}

const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 2);

function match(engineRows, hrName) {
  const want = tokens(hrName);
  let best = null;
  for (const r of engineRows) {
    const have = tokens(r[col.name]);
    if (!have.length) continue;
    const hit = want.filter((w) => have.some((h) => h.startsWith(w) || w.startsWith(h))).length;
    if (hit === 0) continue;
    const score = hit / Math.max(want.length, have.length);
    if (!best || score > best.score) best = { r, score };
  }
  return best && best.score >= 0.4 ? best.r : null;
}

const out = [['tenant', 'name', 'hr_days', 'engine_days', 'engine_att_amount', 'engine_loan', 'engine_tax', 'engine_total_ded', 'engine_net', 'match']];
const used = new Set();
for (const h of hr) {
  const r = match(csv, h.name);
  if (!r) { out.push(['', h.name, h.total, 'NO-MATCH', '', '', '', '', '', '']); continue; }
  used.add(r[col.name]);
  const gross = parseFloat(r[col.gross] || 0);
  const attAmt = parseFloat(r[col.attendance_amount] || 0);
  const days = gross > 0 ? (attAmt / (gross / 31)).toFixed(1) : '0';
  out.push([
    r[col.tenant], r[col.name], h.total, days, attAmt.toFixed(2),
    r[col.loan_amount], r[col.tax_amount], r[col.total_deductions], r[col.net],
    h.dept,
  ].join(','));
}
for (const r of csv) if (!used.has(r[col.name])) out.push([r[col.tenant], r[col.name], 'NOT-IN-HR', r[col.attendance_days] || '0', r[col.attendance_amount], r[col.loan_amount], r[col.tax_amount], r[col.total_deductions], r[col.net], '']);

writeFileSync('/tmp/aug_delta_vs_hr.csv', out.join('\n') + '\n');
console.log(`wrote /tmp/aug_delta_vs_hr.csv (${out.length - 1} rows)`);
process.exit(0);
