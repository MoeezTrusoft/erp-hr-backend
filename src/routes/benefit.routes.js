import express from "express";
import * as ctrl from "../controllers/benefit.controller.js";
import { requirePermission } from "../middlewares/hrContext.middleware.js";

// HR-BENEFITS-04 compatibility gate for isolated router consumers. Production
// requests first pass F-02's verified-scope policy; forged x-user-* headers are
// never authorization truth. Service queries remain tenant-scoped.
const router = express.Router();
const gate = requirePermission("hr:benefits");

// Benefit plans
router.post("/plans", gate, ctrl.createPlan);
router.get("/plans", gate, ctrl.listPlans);
router.get("/plans/:id", gate, ctrl.getPlan);
router.put("/plans/:id", gate, ctrl.updatePlan);
router.delete("/plans/:id", gate, ctrl.deletePlan);

// Enrollment (enroll / unenroll / list an employee's benefits)
router.post("/employees/:employeeId/enroll", gate, ctrl.enrollEmployee);
router.delete("/employees/:employeeId/benefits/:benefitPlanId", gate, ctrl.unenrollEmployee);
router.get("/employees/:employeeId/benefits", gate, ctrl.listEmployeeBenefits);

export default router;
