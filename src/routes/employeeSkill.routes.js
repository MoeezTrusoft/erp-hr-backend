import express from "express";
import * as ctrl from "../controllers/employeeSkill.controller.js";

const router = express.Router();

router.get("/", ctrl.listSkills);
router.post("/", ctrl.createSkill);
router.get("/employee/:employeeId", ctrl.getEmployeeSkills);
router.post("/employee/:employeeId", ctrl.addEmployeeSkill);
router.delete("/:id", ctrl.removeEmployeeSkill);

export default router;
