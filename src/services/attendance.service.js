import { PrismaClient } from '@prisma/client';
import { logAction } from "../utils/logs.js";

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
  const attendanceIn = await prisma.attendance.create({
    data: {
      employeeId: empId,
      date: new Date(date),
      check_in: parsedCheckIn,
      status,
    },
  });

   // Log the update action
    await logAction({
      employeeId: 1,
      type: "Check In", // 👈 changed from CREATE to UPDATE
      module: "Attandance",
      result: "SUCCESS",
      notes: `Attandance check In "${empId}" successfully`,
    });
  return attendanceIn;
};
export const checkOutService = async (employeeId) => {

   const empId = Number(employeeId);
  const attendance = await prisma.attendance.findFirst({
    where: { empId },
    orderBy: { date: "desc" }
  });

  if (!attendance || attendance.check_out)
    throw new Error("No active check-in found");

  const checkOutTime = new Date();
  const totalHours =
    (checkOutTime - attendance.check_in) / (1000 * 60 * 60);

  const checkOut=  await prisma.attendance.update({
    where: { id: attendance.id },
    data: { check_out: checkOutTime, total_hours: totalHours }
  });

   // Log the update action
    await logAction({
      employeeId: 1,
      type: "Check Out", // 👈 changed from CREATE to UPDATE
      module: "Attandance",
      result: "SUCCESS",
      notes: `CHeck Out "${1}" updated successfully`,
    });
return checkOut;
};

export const getAttendanceByEmployee = async (employeeId) => {
  return prisma.attendance.findMany({
    where: { employeeId },
    orderBy: { date: "desc" }
  });
};
