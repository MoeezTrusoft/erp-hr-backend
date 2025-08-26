import { Router } from "express";
import { addEmployee, getEmployees } from "../controllers/hr.controller.js";

const router = Router();

router.post("/", addEmployee);  // POST /api/hr/employees
router.get("/", getEmployees);  // GET /api/hr/employees

export default router;
