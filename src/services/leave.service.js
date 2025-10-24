import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();



export const requestLeaveService = async (data) => {
  const { employeeId, type, start_date, end_date, reason } = data;

  const start = new Date(start_date);
  const end = new Date(end_date);

  if (end < start) throw new Error("End date cannot be before start date");

  // ✅ Fetch holidays in the same date range
  const holidays = await prisma.holiday.findMany({
    where: {
      date: {
        gte: start,
        lte: end,
      },
    },
  });

  // ✅ Generate all working days between start and end
  let totalDays = 0;
  const holidaysSet = new Set(holidays.map((h) => h.date.toDateString()));

  for (
    let d = new Date(start);
    d <= end;
    d.setDate(d.getDate() + 1)
  ) {
    const day = d.getDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6 && !holidaysSet.has(d.toDateString())) {
      totalDays++;
    }
  }

  // ✅ Create leave record
  return prisma.leave.create({
    data: {
      employeeId,
      type,
      start_date: start,
      end_date: end,
      total_days: totalDays,
      reason,
      status: "PENDING",
    },
  });
};
export const approveLeaveService = async (id, data) => {
    const { approved_by, status } = data;

    return prisma.leave.update({
        where: { id: Number(id) },
        data: {
            status,
            approved_by,
            approved_at: new Date(),
        },
    });
};

export const getLeaveByEmployee = async (employeeId) => {
    return prisma.leave.findMany({
        where: { employeeId },
        orderBy: { start_date: "desc" },
    });
};
