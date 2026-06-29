import express from "express";
import * as ctrl from "../controllers/benefit.controller.js";
import { requirePermission } from "../middlewares/hrContext.middleware.js";

// HR-BENEFITS-04 — deny-by-default authz on the benefits surface. Every route
// requires the `hr:benefits` entitlement for the HTTP method's action (VIEW /
// CREATE / EDIT / DELETE), resolved from the gateway-verified permission blob
// (req.user.permissions). The forgeable `x-is-admin` header is never honored —
// a real HR/benefits admin carries the permission. Reads/writes are additionally
// tenant-scoped in the service (cross-tenant → 404).
const gate = requirePermission("hr:benefits");

const router = express.Router();

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
