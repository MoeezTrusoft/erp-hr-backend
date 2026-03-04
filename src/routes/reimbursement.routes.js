import express from "express";
import * as ctrl from "../controllers/reimbursement.controller.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

const router = express.Router();

router.post("/", ctrl.createClaim);
router.get("/", ctrl.listClaims);
router.post("/:id/receipt", dynamicUpload, ctrl.uploadReceipt);
router.put("/:id/submit", ctrl.submitClaim);
router.put("/:id/approve", ctrl.approveClaim);

export default router;
