import express from "express";
import * as ctrl from "../controllers/resume.controller.js";

const router = express.Router();

// AI resume parsing (skills / competencies / certifications).
router.post("/parse-preview", ctrl.previewResume);
router.post("/employees/:employeeId/ingest", ctrl.ingestForEmployee);
router.post("/candidates/:candidateId/ingest", ctrl.ingestForCandidate);

export default router;
