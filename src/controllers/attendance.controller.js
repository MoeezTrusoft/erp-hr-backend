import * as attandanceService from "../services/attendance.service.js";

export const checkIn = async (req, res) => {
  try {
    const result = await attandanceService.createAttendanceService(req.body);
    res.status(200).json({
      message: "Attendance marked successfully",
      attendance: result,
    });
  } catch (error) {
    console.error("❌ checkIn error:", error);
    res.status(400).json({ error: error.message });
  }
};

export const checkOut = async (req, res) => {
  try {
    const { employeeId } = req.body;
    const result = await attandanceService.checkOutService(employeeId);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const getEmployeeAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await attandanceService.getAttendanceByEmployee(Number(id));
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
