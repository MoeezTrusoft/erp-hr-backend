import * as attandanceService from "../services/attendance.service.js";
import {
  getDailyAttendanceSummary,
  probeAttendanceDevice,
  syncAttendanceFromPunches,
} from "../services/attendance.device.service.js";

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
    const { employeeId, timestamp } = req.body;
    const result = await attandanceService.checkOutServiceWithTimestamp(employeeId, timestamp);
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

export const listAttendanceRecords = async (req, res) => {
  try {
    const result = await attandanceService.listAttendanceRecords({
      date: req.query?.date,
      limit: req.query?.limit,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
};

export const testDeviceConnectivity = async (req, res) => {
  try {
    const result = await probeAttendanceDevice(req.body || {});
    return res.status(result.reachable ? 200 : 503).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

export const syncDeviceAttendance = async (req, res) => {
  try {
    const result = await syncAttendanceFromPunches(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

export const getDailyAttendanceStatusSummary = async (req, res) => {
  try {
    const result = await getDailyAttendanceSummary({
      date: req.query?.date,
      shiftStart: req.query?.shiftStart,
      lateGraceMinutes: req.query?.lateGraceMinutes,
    });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};
