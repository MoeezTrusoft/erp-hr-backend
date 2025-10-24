import express from "express";
import {
  checkIn,
  checkOut,
  getEmployeeAttendance,
} from "../controllers/attendance.controller.js";

const router = express.Router();

router.post("/checkin",checkIn);
router.post("/checkout", checkOut);
router.get("/get-attandance/:id", getEmployeeAttendance);

export default router;
