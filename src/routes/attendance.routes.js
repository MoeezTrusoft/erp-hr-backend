import express from "express";
import {
  checkIn,
  checkOut,
  getEmployeeAttendance,
  listAttendanceRecords,
  getDailyAttendanceStatusSummary,
  syncDeviceAttendance,
  testDeviceConnectivity,
} from "../controllers/attendance.controller.js";

const router = express.Router();

router.post("/checkin",checkIn);
router.post("/checkout", checkOut);
router.get("/get-attandance/:id", getEmployeeAttendance);
router.get("/records", listAttendanceRecords);
router.post("/device/connectivity", testDeviceConnectivity);
router.post("/device/sync", syncDeviceAttendance);
router.get("/device/daily-summary", getDailyAttendanceStatusSummary);

export default router;
