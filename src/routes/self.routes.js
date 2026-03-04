import express from "express";
import * as ctrl from "../controllers/self.controller.js";

const router = express.Router();

router.get("/profile", ctrl.getSelfProfile);
router.put("/profile", ctrl.updateSelfProfile);
router.get("/emergency-contacts", ctrl.listSelfEmergencyContacts);
router.post("/emergency-contacts", ctrl.upsertSelfEmergencyContact);
router.put("/emergency-contacts", ctrl.upsertSelfEmergencyContact);
router.get("/payslips", ctrl.listSelfPayslips);
router.get("/leave-balances", ctrl.listSelfLeaveBalances);

export default router;
