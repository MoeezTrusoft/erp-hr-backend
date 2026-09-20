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
    uploadCandidateResume,
} from "../controllers/candidateController.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

import {
    createApplication,
    listApplications,
    updateStage,
    updateStatus,
} from "../controllers/applicationController.js";

import {
    recordConsentHandler,
    listConsentHandler,
    recordDncHandler,
    listDncHandler,
    liftDncHandler,
    placeLegalHoldHandler,
    releaseLegalHoldHandler,
    setRetentionPolicyHandler,
    previewRetentionHandler,
    applyRetentionHandler,
    anonymizeCandidateHandler,
    createDataAccessRequestHandler,
    listDataAccessRequestsHandler,
    closeDataAccessRequestHandler,
} from "../controllers/candidatePrivacy.controller.js";

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
router.post("/candidates/:id/resume", dynamicUpload, uploadCandidateResume);

// APPLICATIONS
router.get("/applications", listApplications);
router.post("/applications", createApplication);
router.put("/applications/:id/stage", updateStage);
router.put("/applications/:id/status", updateStatus);

// PRIVACY (Phase 2.5/10). Mounted under /api/recruitment so F-02 resolves the
// resource to hr.recruitment and the action from the HTTP method — one policy
// model, no per-route declaration to drift.
router.post("/privacy/candidates/:id/consent", recordConsentHandler);
router.get("/privacy/candidates/:id/consent", listConsentHandler);
router.post("/privacy/dnc", recordDncHandler);
router.get("/privacy/dnc", listDncHandler);
router.put("/privacy/dnc/:id/lift", liftDncHandler);
router.post("/privacy/candidates/:id/legal-hold", placeLegalHoldHandler);
router.put("/privacy/candidates/:id/legal-hold/release", releaseLegalHoldHandler);
router.put("/privacy/retention/policy", setRetentionPolicyHandler);
router.get("/privacy/retention/preview", previewRetentionHandler);
router.post("/privacy/retention/apply", applyRetentionHandler);
router.post("/privacy/candidates/:id/anonymize", anonymizeCandidateHandler);
router.post("/privacy/requests", createDataAccessRequestHandler);
router.get("/privacy/requests", listDataAccessRequestsHandler);
router.put("/privacy/requests/:id/close", closeDataAccessRequestHandler);

export default router;
