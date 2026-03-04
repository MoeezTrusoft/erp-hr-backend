import express from "express";
import dynamicUpload from "../middlewares/upload.middleware.js";
import { createEmployee, deleteEmployee, getAllEmployees, getEmployeeById, updateEmployee, uploadEmployeeDocuments} from "../controllers/hr.controller.js";


const router = express.Router();
router.post("/", dynamicUpload, createEmployee);
router.post("/uploadDocuments", dynamicUpload, uploadEmployeeDocuments);
router.get("/", getAllEmployees);
router.get("/:id", getEmployeeById);
router.put("/:id", dynamicUpload, updateEmployee);
router.delete("/:id", deleteEmployee);

export default router;
