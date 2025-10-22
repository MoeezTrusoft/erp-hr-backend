import express from "express";
import { createEmployee, deleteEmployee, getAllEmployees, getEmployeeById, updateEmployee } from "../controllers/hr.controller.js";


const router = express.Router();
router.post("/", createEmployee);
router.get("/get-all",  getAllEmployees);
router.get("/get/:id", getEmployeeById);
router.put("/update/:id",  updateEmployee);
router.delete("/delete/:id",deleteEmployee);

export default router;
