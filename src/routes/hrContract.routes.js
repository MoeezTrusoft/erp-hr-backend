import express from "express";
import * as controller from "../controllers/hrContract.controller.js";
import { requireHrUser } from "../middlewares/hrContext.middleware.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

const router = express.Router();

router.get("/dashboard/widgets", controller.getDashboardWidgets);
router.get("/dashboard/summary", controller.getDashboardSummary);
router.get("/dashboard-layout/me", requireHrUser, controller.getDashboardLayout);
router.put("/dashboard-layout/me", requireHrUser, controller.saveDashboardLayout);
router.post("/dashboard-layout/reset", requireHrUser, controller.resetDashboardLayout);

router.get("/employees", controller.listEmployees);
router.post("/employees", requireHrUser, controller.createEmployee);
router.get("/employees/:id/quick-view", controller.getEmployeeQuickView);
router.get("/employees/:id/profile", controller.getEmployeeProfile);
router.get("/employees/:id/profile/overview", controller.getEmployeeProfileOverview);
router.get("/employees/:id/documents", controller.getEmployeeDocuments);
router.put("/employees/:id", requireHrUser, controller.updateEmployee);
router.patch("/employees/:id/status", requireHrUser, controller.updateEmployeeStatus);
router.post("/employees/:id/profile-photo", requireHrUser, dynamicUpload, controller.uploadEmployeeProfilePhoto);
router.post("/employees/:id/cover-photo", requireHrUser, dynamicUpload, controller.uploadEmployeeCoverPhoto);
router.post("/employees/:id/documents", requireHrUser, dynamicUpload, controller.createEmployeeDocument);
router.put("/employees/:id/documents/:documentId", requireHrUser, dynamicUpload, controller.updateEmployeeDocument);
router.delete("/employees/:id/documents/:documentId", requireHrUser, controller.deleteEmployeeDocument);
router.get("/employees/:id/emergency-contacts", controller.listEmployeeEmergencyContacts);
router.post("/employees/:id/emergency-contacts", requireHrUser, controller.createEmployeeEmergencyContact);
router.put("/employees/:id/emergency-contacts/:contactId", requireHrUser, controller.updateEmployeeEmergencyContact);
router.delete("/employees/:id/emergency-contacts/:contactId", requireHrUser, controller.deleteEmployeeEmergencyContact);

router.get("/positions", controller.listPositions);
router.post("/positions", requireHrUser, controller.createPosition);
router.get("/positions/:id", controller.getPosition);
router.put("/positions/:id", requireHrUser, controller.updatePosition);
router.patch("/positions/:id/status", requireHrUser, controller.updatePositionStatus);

router.get("/requisitions", controller.listRequisitions);
router.post("/requisitions", requireHrUser, controller.createRequisition);
router.get("/requisitions/:id", controller.getRequisition);
router.put("/requisitions/:id", requireHrUser, controller.updateRequisition);
router.post("/requisitions/:id/submit", requireHrUser, controller.submitRequisition);
router.post("/requisitions/:id/approve", requireHrUser, controller.approveRequisition);
router.post("/requisitions/:id/reject", requireHrUser, controller.rejectRequisition);
router.post("/requisitions/:id/close", requireHrUser, controller.closeRequisition);
router.post("/requisitions/:id/reopen", requireHrUser, controller.reopenRequisition);

export default router;
