// src/routes/recruitment.routes.js
import express from "express";

import {
    listTags,
    createTag,
    deactivateTag,
} from "../controllers/tagController.js";

import {
    createCandidate,
    updateCandidate,
    getCandidate,
    listCandidates,
} from "../controllers/candidateController.js";

import {
    createApplication,
    listApplications,
    updateStage,
    updateStatus,
} from "../controllers/applicationController.js";

const router = express.Router();

// TAGS
router.get("/tags", listTags);
router.post("/tags", createTag);
router.delete("/tags/:id", deactivateTag);

// CANDIDATES
router.get("/candidates", listCandidates);
router.post("/candidates", createCandidate);
router.get("/candidates/:id", getCandidate);
router.put("/candidates/:id", updateCandidate);

// APPLICATIONS
router.get("/applications", listApplications);
router.post("/applications", createApplication);
router.put("/applications/:id/stage", updateStage);
router.put("/applications/:id/status", updateStatus);

export default router;
