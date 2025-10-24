import express from "express";
import { deleteEnrollment, enrollEmployee, getAllEnrollments, getEnrollmentById, updateEnrollment, updateEnrollmentProgress } from "../controllers/trainingEnrollment.controller.js";


const router = express.Router();

router.post("/", enrollEmployee);
router.get("/", getAllEnrollments);
router.get("/:id", getEnrollmentById);
router.put("/:id", updateEnrollment);
router.delete("/:id", deleteEnrollment);

router.put("/progress/:id", updateEnrollmentProgress);

export default router;
