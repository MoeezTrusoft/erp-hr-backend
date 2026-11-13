// HR ruling 2026-09-13 — apply and document:
//   1. Shah Hassan Jafry (JOC id=549, BOC id=555): 70K package SPLIT to 35K per
//      tenant (45% BASIC + 7.5% UTIL + 12.5% MED + 15% CONV + 20% HRA), and NO
//      attendance anomaly deduction anywhere. JOC August shows zero duty (his
//      punches are at BOC) — the 23 phantom ABSENT days are credited (the
//      absence-recovery line dies), and BOC's 4 lates (03/05/15/18) are marked
//      manually_corrected (the 3:1 late pool dies).
//   2. Akash (JOC id=554): 18 lates → 6 pooled days. No anomaly per HR → all
//      LATE rows manually_corrected.
//   3. Akash (HomeVision id=160): 5 lates + Aug-29 short-day ABSENT (punches
//      10:35–11:55 exist). No anomaly per HR → lates manually_corrected, Aug-29
//      credited 1.0.
// Mechanism note: manually_corrected rows are skipped by the rules counter AND
// by device re-sync (HR-ATT-CORRECTION-01: "HR's ruling outranks the device");
// the credit-loss bridge honors stored day_credit. Both are the system's own
// semantics for an HR-over-device verdict — no engine change needed.
import { mcpCtx } from '../../src/mcp/context.js';
import prisma from '../../src/lib/prisma.js';

const JOC = '8f4a526f-d45b-4da2-b772-d6682e849812';
const BOC = '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2';
const HV = '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73';
const AUG = { gte: new Date('2026-08-01T00:00:00.000Z'), lte: new Date('2026-08-31T00:00:00.000Z') };
const REASON = 'HR ruling 2026-09-13: no attendance anomaly (operator); package split JOC/BOC 35K+35K where applicable.';

// 70K → 35K split: 45% base + 7.5/12.5/15/20 allowances (JOC/BOC legacy codes).
const SPLIT = {
  TERM_BASE: '15750',
  ALLOWANCES: { UTILITY: '2625', MEDICAL: '4375', CONVEYANCE: '5250', HRA: '7000' },
};

async function creditAbsenceDays(tenantId, employeeId, label) {
  const rows = await prisma.attendance.findMany({
    where: { tenantId, employeeId, date: AUG, status: 'ABSENT' },
  });
  for (const r of rows) {
    await prisma.attendance.update({
      where: { id: r.id },
      data: {
        day_credit: 1.0,
        manually_corrected: true,
        corrected_at: new Date(),
        correction_reason: REASON,
        remarks: `${r.remarks ?? ''} | HR ruling 2026-09-13: day credited — no deduction.`.trim(),
      },
    });
  }
  console.log(`${label}: credited ${rows.length} ABSENT day(s) -> day_credit 1.0 + manually_corrected`);
  return rows.length;
}

async function correctLateDays(tenantId, employeeId, label) {
  const rows = await prisma.attendance.findMany({
    where: { tenantId, employeeId, date: AUG, status: 'LATE' },
  });
  for (const r of rows) {
    await prisma.attendance.update({
      where: { id: r.id },
      data: {
        manually_corrected: true,
        corrected_at: new Date(),
        correction_reason: REASON,
        remarks: `${r.remarks ?? ''} | HR ruling 2026-09-13: late excused — no deduction.`.trim(),
      },
    });
  }
  console.log(`${label}: marked ${rows.length} LATE day(s) manually_corrected`);
  return rows.length;
}

async function splitPackage(tenantId, employeeId, label) {
  const term = await prisma.employmentTerms.findFirst({
    where: { tenantId, employeeId, effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!term) throw new Error(`${label}: no open employment term`);
  await prisma.employmentTerms.update({ where: { id: term.id }, data: { baseSalary: SPLIT.TERM_BASE } });

  const assigns = await prisma.payrollAssignment.findMany({
    where: { tenantId, employeeId, isActive: true, effectiveTo: null, earningTypeId: { not: null } },
    include: { earningType: true },
  });
  for (const a of assigns) {
    const code = a.earningType?.code;
    const target = code === 'BASIC' || code === 'BASE_SALARY'
      ? SPLIT.TERM_BASE
      : SPLIT.ALLOWANCES[code];
    if (!target) { console.log(`${label}: ${code} assignment left untouched (not in split map)`); continue; }
    await prisma.payrollAssignment.update({ where: { id: a.id }, data: { amount: target } });
  }
  const pkg = [SPLIT.TERM_BASE, ...Object.values(SPLIT.ALLOWANCES)].reduce((s, v) => s + Number(v), 0);
  console.log(`${label}: term base -> ${SPLIT.TERM_BASE}, allowances resized, package now ${pkg}`);
}

await mcpCtx.run({ system: true }, async () => {
  // --- Shah Hassan ---
  const jocSH = 549, bocSH = 555;
  await creditAbsenceDays(JOC, jocSH, 'Shah Hassan JOC');
  await correctLateDays(BOC, bocSH, 'Shah Hassan BOC');
  await splitPackage(JOC, jocSH, 'Shah Hassan JOC 35K split');
  await splitPackage(BOC, bocSH, 'Shah Hassan BOC 35K split');

  // --- Akash ---
  await correctLateDays(JOC, 554, 'Akash JOC');
  const hvLate = await correctLateDays(HV, 160, 'Akash HomeVision');
  // Aug-29: punches exist (10:35-11:55), HR says no anomaly -> credit the day.
  const a29 = await prisma.attendance.findFirst({
    where: { tenantId: HV, employeeId: 160, date: new Date('2026-08-29T00:00:00.000Z') },
  });
  if (a29) {
    await prisma.attendance.update({
      where: { id: a29.id },
      data: {
        day_credit: 1.0,
        manually_corrected: true,
        corrected_at: new Date(),
        correction_reason: REASON,
        remarks: `${a29.remarks ?? ''} | HR ruling 2026-09-13: short day with punches — credited.`.trim(),
      },
    });
    console.log('Akash HomeVision: Aug-29 credited 1.0 + manually_corrected');
  }

  console.log('\n--- POST-FIX STATE ---');
  for (const [label, tid, eid] of [
    ['Shah Hassan JOC', JOC, 549],
    ['Shah Hassan BOC', BOC, 555],
    ['Akash JOC', JOC, 554],
    ['Akash HomeVision', HV, 160],
  ]) {
    const uncorrected = await prisma.attendance.count({
      where: { tenantId: tid, employeeId: eid, date: AUG, manually_corrected: false, status: { in: ['LATE', 'ABSENT'] } },
    });
    const term = await prisma.employmentTerms.findFirst({ where: { tenantId: tid, employeeId: eid, effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } });
    console.log(`${label}: uncorrected LATE/ABSENT rows=${uncorrected}, term base=${term?.baseSalary}`);
  }
});