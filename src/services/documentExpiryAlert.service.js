import prisma from "../config/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";

// C.2-completion — this scan runs from BOTH the daily cron (no tenant — scans
// every tenant's documents) and request context. A request-context caller may
// pass `tenantId` to scope the scan + the alerts it creates to one tenant; the
// cron path leaves `tenantId` undefined to preserve the fleet-wide scan.
export const generateDocumentExpiryAlerts = async ({ daysBefore = [30, 14, 7], tenantId } = {}) => {
  const now = new Date();

  const docs = await prisma.employeeMedia.findMany({
    where: scopedWhere(tenantId, {
      expiry_date: { not: null, gte: now },
      employee_id: { not: null },
    }),
    select: { id: true, employee_id: true, expiry_date: true },
  });

  const created = [];
  for (const doc of docs) {
    const ms = doc.expiry_date.getTime() - now.getTime();
    const days = Math.ceil(ms / (1000 * 60 * 60 * 24));

    if (!daysBefore.includes(days)) continue;

    const existing = await prisma.documentExpiryAlert.findFirst({
      where: scopedWhere(tenantId, {
        employeeMediaId: doc.id,
        daysBeforeExpiry: days,
      }),
    });

    if (existing) continue;

    const alert = await prisma.documentExpiryAlert.create({
      data: {
        employeeMediaId: doc.id,
        employeeId: doc.employee_id,
        alertDate: now,
        daysBeforeExpiry: days,
        ...(tenantId === undefined ? {} : { tenantId: tenantId ?? null }),
      },
    });
    created.push(alert);
  }

  return created;
};
