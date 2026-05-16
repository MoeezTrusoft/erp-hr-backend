import express from "express";
import * as ctrl from "../controllers/onboarding.controller.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

const router = express.Router();

// Checklists
router.post("/checklists", ctrl.createChecklist);
router.get("/checklists", ctrl.listChecklists);
router.get("/checklists/:id", ctrl.getChecklist);
router.put("/checklists/:id", ctrl.updateChecklist);
router.get("/employee/:employeeId", ctrl.getChecklistByEmployee);

// Tasks
router.post("/checklists/:id/tasks", ctrl.addTask);
router.put("/tasks/:taskId", ctrl.updateTask);
router.delete("/tasks/:taskId", ctrl.deleteTask);

// Documents
router.post("/checklists/:id/documents", dynamicUpload, ctrl.uploadDocument);
router.get("/checklists/:id/documents", ctrl.listDocuments);
router.put("/documents/:docId/sign", ctrl.signDocument);

// Buddy
router.post("/checklists/:id/buddy", ctrl.assignBuddy);
router.get("/checklists/:id/buddy", ctrl.getBuddy);

// Surveys
router.post("/surveys", ctrl.submitSurvey);
router.get("/surveys/:employeeId", ctrl.getSurveys);

export default router;
