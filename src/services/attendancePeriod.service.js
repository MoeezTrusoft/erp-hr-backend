import { Prisma } from "@prisma/client";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { dateOnly } from "../lib/attendanceDates.js";
export async function lockAttendancePeriod(db, tenantId, exclusive = false) {
  if (!tenantId)
    throw Object.assign(new Error("Attendance requires a tenant"), {
      status: 401,
    });
  if (db.$executeRaw) {
    const key = tenantId + ":attendance-period";
    if (exclusive)
      await db.$executeRaw(
        Prisma.sql(["SELECT pg_advisory_xact_lock(hashtext(", "))"], key),
      );
    else
      await db.$executeRaw(
        Prisma.sql(
          ["SELECT pg_advisory_xact_lock_shared(hashtext(", "))"],
          key,
        ),
      );
  }
}
export async function assertAttendancePeriodOpen(db, tenantId, from, to) {
  await lockAttendancePeriod(db, tenantId);
  const locked = await db.payrollRun.findFirst({
    where: {
      tenantId,
      periodStart: { lte: new Date(+dateOnly(to) + 86399999) },
      periodEnd: { gte: dateOnly(from) },
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
    select: { id: true },
  });
  if (locked)
    throw Object.assign(
      new Error(
        "PERIOD_PROTECTED: recall or cancel payroll before changing attendance",
      ),
      { status: 409 },
    );
}
export function attendanceTransaction(db, tenantId, fn) {
  return db.$transaction
    ? tenantTransaction(db, fn, {
        tenantId,
        txOptions: { timeout: 60000, maxWait: 10000 },
      })
    : fn(db);
}
