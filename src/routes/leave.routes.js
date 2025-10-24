import express from "express";
import {
  requestLeave,
  approveLeave,
  getEmployeeLeaves,
} from "../controllers/leave.controller.js";

const router = express.Router();

router.post("/", requestLeave);
router.put("/:id", approveLeave);
router.get("/:id", getEmployeeLeaves);

export default router;
