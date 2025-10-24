import express from "express";
import { createEmployee, deleteEmployee, getAllEmployees, getEmployeeById, updateEmployee } from "../controllers/hr.controller.js";


const router = express.Router();
router.post("/", createEmployee);
router.get("/",  getAllEmployees);
router.get("/:id", getEmployeeById);
router.put("/:id",  updateEmployee);
router.delete("/:id",deleteEmployee);

export default router;
