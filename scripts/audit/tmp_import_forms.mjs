// Import the 36 paper anomaly-form dispositions (hr-data/anomaly-forms-august-2026)
// into attendance_anomalies as the authoritative HR paper trail.
//
// Mapping (operator rulings 2026-09-11):
//   APPROVED leave/late form  -> APPROVED anomaly  -> engine EXCUSES the day
//   Partially approved        -> APPROVED on approved dates, REJECTED on the rest
//   DISAPPROVED leave form    -> OTHER/REJECTED (the ABSENT day is already charged
//                                via day_credit=0; a REJECTED ABSENT anomaly would
//                                add a DISAPPROVED_LEAVE rule day = double charge)
//   DISAPPROVED late/missing  -> <type>/REJECTED — ledger-only, counts as a pooled
//                                violation exactly like HR's register
//   PENDING device anomalies matching a disapproved paper form -> REJECTED
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

const T = {
  TRUSOFT: '40314ef4-0a81-4390-b631-b3ad3f21f523',
  HOMENET: '8ff0533b-62f6-4be9-a78e-69adf49e00bc',
  HOMEVISION: '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73',
  JOC: '8f4a526f-d45b-4da2-b772-d6682e849812',
};
const d = (s) => new Date(`${s}T00:00:00.000Z`);

// [tenant, employeeId, type, status, date, applicationDate, reason, sourceRef]
const ROWS = [
  // ── TruSoft (all disapproved) ──────────────────────────────────────────────
  [T.TRUSOFT, 495, 'OTHER', 'REJECTED', '2026-08-05', '2026-08-06', 'Paper leave form DISAPPROVED (fever/migraine); day charged as absence', 'TruSoft-Applications.pdf p1'],
  [T.TRUSOFT, 491, 'LATE_CHECKIN', 'REJECTED', '2026-08-04', '2026-08-04', 'Paper late form DISAPPROVED (bike breakdown)', 'TruSoft-Applications.pdf p2'],
  [T.TRUSOFT, 485, 'LATE_CHECKIN', 'REJECTED', '2026-08-31', '2026-08-31', 'Paper late form DISAPPROVED (relative funeral)', 'TruSoft-Applications.pdf p3'],
  [T.TRUSOFT, 491, 'LATE_CHECKIN', 'REJECTED', '2026-08-23', '2026-08-23', 'Paper late form DISAPPROVED', 'TruSoft-Applications.pdf p5'],
  [T.TRUSOFT, 482, 'LATE_CHECKIN', 'REJECTED', '2026-08-11', '2026-08-11', 'Paper late form DISAPPROVED', 'TruSoft-Applications.pdf p7'],
  [T.TRUSOFT, 497, 'LATE_CHECKIN', 'REJECTED', '2026-08-13', '2026-08-13', 'Paper late form DISAPPROVED', 'TruSoft-Applications.pdf p8'],
  [T.TRUSOFT, 497, 'MISSING_CHECKOUT', 'REJECTED', '2026-08-10', '2026-08-10', 'Paper missing-checkout form DISAPPROVED', 'TruSoft-Applications.pdf p9'],
  [T.TRUSOFT, 493, 'OTHER', 'REJECTED', '2026-08-19', '2026-08-19', 'Paper leave form DISAPPROVED (medical); day charged as absence', 'TruSoft-Applications.pdf p10'],
  [T.TRUSOFT, 488, 'OTHER', 'REJECTED', '2026-08-19', '2026-08-19', 'Paper leave form DISAPPROVED (medical); day charged as absence', 'TruSoft-Applications.pdf p11'],
  [T.TRUSOFT, 486, 'LATE_CHECKIN', 'REJECTED', '2026-08-24', '2026-08-24', 'Paper late form DISAPPROVED', 'TruSoft-Applications.pdf p12'],
  // ── HomeNet ───────────────────────────────────────────────────────────────
  [T.HOMENET, 504, 'OTHER', 'APPROVED', '2026-08-13', '2026-08-17', 'Paper leave form APPROVED (casual/full, nephew death)', 'HomeNet-Applications.pdf p1'],
  [T.HOMENET, 500, 'OTHER', 'APPROVED', '2026-08-01', '2026-08-01', 'Saturday no-work form APPROVED', 'HomeNet-Applications.pdf p7'],
  [T.HOMENET, 500, 'OTHER', 'APPROVED', '2026-08-08', '2026-08-08', 'Saturday no-work form APPROVED', 'HomeNet-Applications.pdf p8'],
  [T.HOMENET, 500, 'OTHER', 'APPROVED', '2026-08-15', '2026-08-17', 'Saturday no-work form APPROVED', 'HomeNet-Applications.pdf p2'],
  [T.HOMENET, 500, 'OTHER', 'APPROVED', '2026-08-22', '2026-08-24', 'Saturday no-work form APPROVED', 'HomeNet-Applications.pdf p3'],
  [T.HOMENET, 533, 'OTHER', 'APPROVED', '2026-08-18', '2026-08-27', 'Bereavement leave PARTIALLY APPROVED: 18–23 Aug per HR red note', 'HomeNet-Applications.pdf p4'],
  [T.HOMENET, 533, 'OTHER', 'APPROVED', '2026-08-19', '2026-08-27', 'Bereavement leave PARTIALLY APPROVED: 18–23 Aug', 'HomeNet-Applications.pdf p4'],
  [T.HOMENET, 533, 'OTHER', 'APPROVED', '2026-08-20', '2026-08-27', 'Bereavement leave PARTIALLY APPROVED: 18–23 Aug', 'HomeNet-Applications.pdf p4'],
  [T.HOMENET, 533, 'OTHER', 'APPROVED', '2026-08-21', '2026-08-27', 'Bereavement leave PARTIALLY APPROVED: 18–23 Aug', 'HomeNet-Applications.pdf p4'],
  [T.HOMENET, 533, 'OTHER', 'APPROVED', '2026-08-22', '2026-08-27', 'Bereavement leave PARTIALLY APPROVED: 18–23 Aug', 'HomeNet-Applications.pdf p4'],
  [T.HOMENET, 533, 'OTHER', 'APPROVED', '2026-08-23', '2026-08-27', 'Bereavement leave PARTIALLY APPROVED: 18–23 Aug', 'HomeNet-Applications.pdf p4'],
  [T.HOMENET, 533, 'OTHER', 'REJECTED', '2026-08-24', '2026-08-27', 'Bereavement leave extension DISAPPROVED (24–26 Aug)', 'HomeNet-Applications.pdf p4'],
  [T.HOMENET, 533, 'OTHER', 'REJECTED', '2026-08-25', '2026-08-27', 'Bereavement leave extension DISAPPROVED (24–26 Aug)', 'HomeNet-Applications.pdf p4'],
  [T.HOMENET, 533, 'OTHER', 'REJECTED', '2026-08-26', '2026-08-27', 'Bereavement leave extension DISAPPROVED (24–26 Aug)', 'HomeNet-Applications.pdf p4'],
  [T.HOMENET, 526, 'LATE_CHECKIN', 'REJECTED', '2026-08-02', '2026-08-02', 'Paper late form DISAPPROVED', 'HomeNet-Applications.pdf p5'],
  [T.HOMENET, 508, 'OTHER', 'REJECTED', '2026-08-08', '2026-08-08', 'Paper leave form DISAPPROVED (day is his Saturday off — no charge)', 'HomeNet-Applications.pdf p9'],
  // ── HomeVision ────────────────────────────────────────────────────────────
  [T.HOMEVISION, 167, 'OTHER', 'REJECTED', '2026-08-16', '2026-08-16', 'Paper leave form DISAPPROVED (day is weekly off — no charge)', 'HomeVision-Applications.pdf p12'],
  // ── JOC (Jiffy entity) ────────────────────────────────────────────────────
  [T.JOC, 552, 'OTHER', 'REJECTED', '2026-08-02', '2026-08-02', 'Paper leave form DISAPPROVED (wife fever; day is Sunday off — no charge)', 'Jiffy-Applications.pdf p1'],
];

await mcpCtx.run({ system: true }, async () => {
  let created = 0, updated = 0, skipped = 0;
  for (const [tenantId, employeeId, type, status, date, appDate, reason, sourceRef] of ROWS) {
    // dedupe on the REAL unique key (tenantId, sourceKind, sourceRef) — earlier
    // partial runs may have inserted some rows already.
    const existing = await prisma.attendanceAnomaly.findFirst({
      where: { tenantId, sourceKind: 'PAPER_FORM', sourceRef },
    });
    if (existing) {
      const differs = existing.status !== status || existing.employeeId !== employeeId || existing.type !== type;
      if (differs) {
        await prisma.attendanceAnomaly.update({ where: { id: existing.id }, data: { status, employeeId, type, date: d(date), reviewNote: reason, decidedAt: d('2026-09-01') } });
        updated++;
      } else { skipped++; }
      continue;
    }
    await prisma.attendanceAnomaly.create({
      data: {
        tenantId, employeeId, type, status,
        date: d(date), applicationDate: d(appDate),
        reason, sourceKind: 'PAPER_FORM', sourceRef,
        currentApprovalLevel: 1, decidedAt: d('2026-09-01'),
      },
    });
    created++;
  }
  console.log(`forms import: created=${created} updated=${updated} skipped(already-consistent)=${skipped}`);

  // Usman (508) off-days corrected to Sun-Mon AFTER the backfill: drop the
  // backfilled ABSENT rows that now fall on his rest days (Aug Sat + Mondays).
  const del = await prisma.attendance.deleteMany({
    where: { tenantId: T.HOMENET, employeeId: 508, remarks: 'AUGUST-BACKFILL', status: 'ABSENT',
      date: { gte: d('2026-08-01'), lte: d('2026-08-31') },
      OR: [{ date: d('2026-08-01') }, { date: d('2026-08-08') }, { date: d('2026-08-31') }, { date: d('2026-08-03') }, { date: d('2026-08-10') }, { date: d('2026-08-17') }, { date: d('2026-08-24') }] },
  });
  console.log(`Usman (508) rest-day absences removed: ${del.count}`);
  const delSep = await prisma.attendance.deleteMany({
    where: { tenantId: T.HOMENET, employeeId: 508, remarks: 'SEP-BACKFILL-REST' },
  });
  console.log(`Usman (508) stale September rest rows removed: ${delSep.count}`);
});

await prisma.$disconnect();
process.exit(0);
