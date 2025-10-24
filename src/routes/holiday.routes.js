import express from "express";
import { createHoliday, deleteHoliday, getAllHolidays, getHolidayById, updateHoliday } from "../controllers/holiday.controller.js";

const router = express.Router();


router.post("/", createHoliday);
router.get("/all", getAllHolidays);
router.get("/:id", getHolidayById);
router.put("/:id", updateHoliday);
router.delete("/:id", deleteHoliday);

export default router;
