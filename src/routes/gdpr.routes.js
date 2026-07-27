import express from "express";
import * as ctrl from "../controllers/gdpr.controller.js";
import { requireHrUser, requirePermission } from "../middlewares/hrContext.middleware.js";

// HR-SEC-07 compatibility gates for isolated router consumers. Production uses
// F-02's verified actor + exact hr.gdpr.export/delete policy first; tenant scope
// remains enforced in the service.
const router = express.Router();

router.use(requireHrUser);
router.get("/export/:employeeId", requirePermission("hr:gdpr"), ctrl.exportData);
router.delete("/erase/:employeeId", requirePermission("hr:gdpr"), ctrl.eraseData);

export default router;
