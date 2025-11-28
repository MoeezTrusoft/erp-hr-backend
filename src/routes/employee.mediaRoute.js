import { Router } from "express";
import dynamicUpload from "../middlewares/upload.middleware.js";

import {
  createEmployeeMedia,
  getAllEmployeeMedia,
  getEmployeeMediaById,
  updateEmployeeMedia,
  deleteEmployeeMedia,
} from "../controllers/employee.mediaController.js";

const router = Router();

router.post("/", dynamicUpload, createEmployeeMedia);
router.get("/", getAllEmployeeMedia);
router.get("/:id", getEmployeeMediaById);
router.put("/:id", dynamicUpload, updateEmployeeMedia);
router.delete("/:id", deleteEmployeeMedia);

export default router;
