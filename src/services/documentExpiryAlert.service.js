import prisma from "../config/prisma.js";

export const generateDocumentExpiryAlerts = async ({ daysBefore = [30, 14, 7] } = {}) => {
  const now = new Date();

  const docs = await prisma.employeeMedia.findMany({
    where: {
      expiry_date: { not: null, gte: now },
      employee_id: { not: null },
    },
    select: { id: true, employee_id: true, expiry_date: true },
  });

  const created = [];
  for (const doc of docs) {
    const ms = doc.expiry_date.getTime() - now.getTime();
    const days = Math.ceil(ms / (1000 * 60 * 60 * 24));

    if (!daysBefore.includes(days)) continue;

    const existing = await prisma.documentExpiryAlert.findFirst({
      where: {
        employeeMediaId: doc.id,
        daysBeforeExpiry: days,
      },
    });

    if (existing) continue;

    const alert = await prisma.documentExpiryAlert.create({
      data: {
        employeeMediaId: doc.id,
        employeeId: doc.employee_id,
        alertDate: now,
        daysBeforeExpiry: days,
      },
    });
    created.push(alert);
  }

  return created;
};
