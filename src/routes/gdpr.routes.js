import express from "express";
import * as ctrl from "../controllers/gdpr.controller.js";
import { requireHrUser, requirePermission } from "../middlewares/hrContext.middleware.js";

// HR-SEC-07 — deny-by-default authz on the GDPR (DPO) surface. Before the fix
// these routes had NO authenticate, NO permission gate and NO tenant scope, so
// any caller past the service boundary (or a wrong-tenant caller) could export
// or IRREVERSIBLY ERASE any employee by raw id. Now:
//   * requireHrUser     — authentication: no gateway-resolved identity → 401.
//   * requirePermission('hr:gdpr') — the caller must hold the admin/DPO-level
//     hr:gdpr entitlement for the method's action (VIEW to export, DELETE to
//     erase). A forged x-is-admin header grants nothing (deny-by-default).
//   * tenant scope is enforced in the service: a wrong-tenant id 404s without
//     reading or mutating any data (see gdpr.service.js).
const router = express.Router();

router.use(requireHrUser);

router.get("/export/:employeeId", requirePermission("hr:gdpr"), ctrl.exportData);
router.delete("/erase/:employeeId", requirePermission("hr:gdpr"), ctrl.eraseData);

export default router;
