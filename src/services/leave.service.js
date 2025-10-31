import { PrismaClient } from "@prisma/client";
import { logAction } from "../utils/logs.js";

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
 const leave= await prisma.leave.create({
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
 // Log the update action
  await logAction({
    employeeId: employeeId,
    type: "Leave request", // 👈 changed from CREATE to UPDATE
    module: "Leave",
    result: "SUCCESS",
    notes: `Leave "${employeeId}" Requested successfully`,
  });

};
export const approveLeaveService = async (id, data) => {
    const { approved_by, status } = data;

    const updateLeave = await prisma.leave.update({
        where: { id: Number(id) },
        data: {
            status,
            approved_by,
            approved_at: new Date(),
        },
    });

     // Log the update action
  await logAction({
    employeeId: 1,
    type: "UPDATE", // 👈 changed from CREATE to UPDATE
    module: "Leave",
    result: "SUCCESS",
    notes: `Leave "${id}" updated successfully`,
  });

  return updateLeave;
};

export const getLeaveByEmployee = async (employeeId) => {
    return prisma.leave.findMany({
        where: { employeeId },
        orderBy: { start_date: "desc" },
    });
};
