import express from "express";
import * as ctrl from "../controllers/certification.controller.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

const router = express.Router();

router.post("/", ctrl.createCertification);
router.get("/", ctrl.listCertifications);
router.put("/:id", ctrl.updateCertification);
router.delete("/:id", ctrl.deleteCertification);
router.post("/:id/upload", dynamicUpload, ctrl.uploadCertificateFile);
router.get("/transcript/:employeeId", ctrl.getTranscript);

export default router;
