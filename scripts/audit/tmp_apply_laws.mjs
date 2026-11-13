// RULINGS APPLICATION 2026-09-11 (final law set, user-confirmed):
//   L1 Trusoft: >30 min late = HALF_DAY (0.5 direct). Sub-grace lates pool 3:1.
//   L2 Disapproved leave w/o punch = 1.0 absence (already credit-driven).
//   A) Revert F1's ">3h re-bucket" flips — restore writer-derived HALF_DAY (≥30min law).
//   B) Trusoft per-employee fixes (Qasim/Shahzaib/Kashif/Faique/Obaid/Farhan).
//   C) Trusoft deductionBasis → POOLED_FLOOR_DIRECT (N-20).
//   D) Qasim paper-form ledger row.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

const T = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const AUG = { gte: new Date('2026-08-01T00:00:00Z'), lt: new Date('2026-09-01T00:00:00Z') };
const day = (s) => new Date(`${s}T00:00:00.000Z`);

await mcpCtx.run({ system: true }, async () => {
  // ── A) revert F1 re-buckets (restore HALF_DAY 0.5 — ≥30min law) ────────────
  const f1rows = await prisma.attendance.findMany({ where: { remarks: { contains: '>3h=HALF_DAY re-bucket' } }, select: { id: true, employeeId: true, date: true, status: true } });
  let reverted = 0;
  for (const r of f1rows) {
    if (r.status === 'HALF_DAY') continue; // kept rows — nothing to revert
    await prisma.attendance.updateMany({
      where: { id: r.id },
      data: { status: 'HALF_DAY', day_credit: 0.5, remarks: 'POLICY 2026-09-11 v2: restored writer HALF_DAY (>=30min late law); earlier >3h re-bucket reverted' },
    });
    reverted++;
  }
  console.log(`A) F1 reverts: ${reverted} of ${f1rows.length} marked rows`);

  // ── B) Trusoft per-employee fixes ──────────────────────────────────────────
  const flip = async (emp, d, from, to, credit, remark) => {
    const u = await prisma.attendance.updateMany({
      where: { employeeId: emp, tenantId: T, date: day(d), status: from },
      data: { status: to, day_credit: credit, remarks: `POLICY 2026-09-11 v2: ${remark}` },
    });
    console.log(`B) emp=${emp} ${d} ${from}→${to}: ${u.count}`);
    return u.count;
  };

  // Qasim 480 — Aug 5 half-day-late form DISAPPROVED (45 min): LATE→HALF_DAY
  await flip(480, '2026-08-05', 'LATE', 'HALF_DAY', 0.5, '45min late, half-day-late form DISAPPROVED (TruSoft-Applications p13)');
  // Shahzaib 483 — HR charges 0; his three sub-30min lates excused
  for (const d of ['2026-08-03', '2026-08-10', '2026-08-24']) {
    await flip(483, d, 'LATE', 'PRESENT', 1.0, 'HR register charges 0; sub-30min late excused (user ruling)');
  }
  // Kashif 488 — Aug 18 3h13m late = HALF by 30-min law; Aug 19 has punch
  // evidence (device enrolment 3113, IN 14:58 PKT) → worked, backfill retracted
  await flip(488, '2026-08-18', 'LATE', 'HALF_DAY', 0.5, '3h13m late > 30min = half day (Trusoft law)');
  await flip(488, '2026-08-19', 'ABSENT', 'PRESENT', 1.0, 'punch evidence device 3113 IN 14:58 PKT; disapproved-leave day worked');
  // Faique 489 — Aug 17 35min = HALF; remaining 6 lates pool 3:1 → 2.0
  await flip(489, '2026-08-17', 'LATE', 'HALF_DAY', 0.5, '35min late > 30min = half day (Trusoft law)');
  // Obaid 493 — Aug 3 (3h06m) + Aug 6 (2h46m) halves; Aug 19 stays ABSENT 1.0
  await flip(493, '2026-08-03', 'LATE', 'HALF_DAY', 0.5, '3h06m late > 30min = half day (Trusoft law)');
  await flip(493, '2026-08-06', 'LATE', 'HALF_DAY', 0.5, '2h46m late > 30min = half day (Trusoft law)');
  // Farhan 497 — Aug 3 no biometric data → no pay loss; Aug 10 missing-checkout
  // form DISAPPROVED = half; Aug 13 9min late but half-day form DISAPPROVED = 0.5;
  // Aug 31 check-in 17:54 PKT vs 18:00 revised shift → on time
  await flip(497, '2026-08-03', 'ABSENT', 'PRESENT', 1.0, 'no biometric data per HR; no pay loss (user ruling)');
  await flip(497, '2026-08-10', 'PRESENT', 'HALF_DAY', 0.5, 'missing-checkout form DISAPPROVED (TruSoft-Applications p9) = half day');
  await flip(497, '2026-08-13', 'PRESENT', 'HALF_DAY', 0.5, 'half-day-late form DISAPPROVED (TruSoft-Applications p8) = half day');
  await flip(497, '2026-08-31', 'LATE', 'PRESENT', 1.0, 'check-in 17:54 PKT vs 18:00 revised shift = on time (device PKT wall-clock)');

  // ── C) Trusoft deduction basis → POOLED_FLOOR_DIRECT (N-20) ───────────────
  const cfg = await prisma.payrollRuleConfig.updateMany({
    where: { tenantId: T },
    data: { deductionBasis: 'POOLED_FLOOR_DIRECT' },
  });
  console.log(`C) ruleConfig updated: ${cfg.count}`);

  // ── D) Qasim paper-form ledger row (paper trail) ──────────────────────────
  const up = await prisma.attendanceAnomaly.upsert({
    where: { tenantId_sourceKind_sourceRef: { tenantId: T, sourceKind: 'PAPER_FORM', sourceRef: 'TruSoft-Applications.pdf p13' } },
    update: {},
    create: {
      tenantId: T, employeeId: 480, type: 'LATE_CHECKIN', status: 'REJECTED',
      date: day('2026-08-05'), sourceKind: 'PAPER_FORM', sourceRef: 'TruSoft-Applications.pdf p13',
      reason: 'Half-day-late form DISAPPROVED (house-related movement, ~45 min)',
      reviewNote: 'Applicant handwriting best-effort transcription; approved/disapproved column = disapproved',
    },
  }).catch((e) => ({ error: e.message.slice(0, 120) }));
  console.log(`D) Qasim ledger: ${JSON.stringify(up).slice(0, 140)}`);
});

await prisma.$disconnect();
process.exit(0);
