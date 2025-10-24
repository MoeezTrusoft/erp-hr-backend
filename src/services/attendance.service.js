import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const createAttendanceService = async (data) => {
  const { employeeId, date, check_in, status } = data;

  if (!employeeId) throw new Error("employeeId is required");
  if (!date) throw new Error("date is required");
  if (!check_in) throw new Error("check_in is required");

  const empId = Number(employeeId);

  // ✅ Ensure employee exists
  const employee = await prisma.employee.findUnique({
    where: { id: empId },
  });
  if (!employee) throw new Error("Employee not found");

  // ✅ Convert "09:00 AM" → ISO Date
  const parsedCheckIn = new Date(`${date} ${check_in}`);

  // ✅ Create attendance record
  const attendance = await prisma.attendance.create({
    data: {
      employeeId: empId,
      date: new Date(date),
      check_in: parsedCheckIn,
      status,
    },
  });

  return attendance;
};
export const checkOutService = async (employeeId) => {
  const attendance = await prisma.attendance.findFirst({
    where: { employeeId },
    orderBy: { date: "desc" }
  });

  if (!attendance || attendance.check_out)
    throw new Error("No active check-in found");

  const checkOutTime = new Date();
  const totalHours =
    (checkOutTime - attendance.check_in) / (1000 * 60 * 60);

  return await prisma.attendance.update({
    where: { id: attendance.id },
    data: { check_out: checkOutTime, total_hours: totalHours }
  });
};

export const getAttendanceByEmployee = async (employeeId) => {
  return prisma.attendance.findMany({
    where: { employeeId },
    orderBy: { date: "desc" }
  });
};
