import { requireCandidatePrivacyAdmin } from "../middlewares/candidatePrivacyAccess.middleware.js";
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
  listHiringFreezesController,
  setHiringFreezeController,
  liftHiringFreezeController,
} from "../controllers/recruitmentFreeze.controller.js";

import {
  listApprovalMatrixController,
  getDefaultApprovalMatrixController,
  setApprovalMatrixController,
  seedDefaultApprovalMatrixController,
} from "../controllers/requisitionApprovalChain.controller.js";

import {
  recordScreeningHandler,
  listScreeningsHandler,
  listDispositionReasonsHandler,
  versionDispositionReasonHandler,
  deactivateDispositionReasonHandler,
  addToShortlistHandler,
  listShortlistHandler,
  removeFromShortlistHandler,
} from "../controllers/applicationScreening.controller.js";

import {
  addPacketItemHandler,
  listPacketHandler,
  removePacketItemHandler,
  myPacketViewHandler,
} from "../controllers/interviewPacket.controller.js";

import {
  cancelInterviewHandler,
  requestRescheduleHandler,
  confirmRescheduleHandler,
  availabilityHandler,
  markCalendarSyncHandler,
  listLifecycleEventsHandler,
} from "../controllers/interviewSchedule.controller.js";

import {
  createTemplateHandler,
  updateTemplateHandler,
  deactivateTemplateHandler,
  listTemplatesHandler,
  linkTemplateHandler,
  unlinkTemplateHandler,
  resolveTemplateHandler,
} from "../controllers/scorecardTemplate.controller.js";

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
  exportDataAccessRequestHandler,
} from "../controllers/candidatePrivacy.controller.js";
import {
  matchCandidateHandler,
  reconcileSkillsHandler,
} from "../controllers/aiAdvisory.controller.js";
import { idempotency } from "../middlewares/idempotency.middleware.js";

const router = express.Router();

// Phase 14 — replay protection on the three CREATE surfaces where a double-
// click or a network retry would duplicate a business object (an application
// against a requisition, an offer against an application, a candidate).
// Opt-in per request via Idempotency-Key (header or body.idempotencyKey); the
// middleware namespaces by the VERIFIED tenant, fails open on store errors,
// and only applies to POSTs with JSON bodies already parsed.
const createIdempotency = idempotency();

// TAGS
router.get("/tags", listTags);
router.post("/tags", createTag);
router.delete("/tags/:id", deactivateTag);

// CANDIDATES
router.get("/candidates", listCandidates);
router.post("/candidates", createIdempotency, createCandidate);
router.get("/candidates/:id", getCandidate);
router.put("/candidates/:id", updateCandidate);
router.post("/candidates/:id/resume", dynamicUpload, uploadCandidateResume);

// APPLICATIONS
router.get("/applications", listApplications);
router.post("/applications", createIdempotency, createApplication);
router.put("/applications/:id/stage", updateStage);
router.put("/applications/:id/status", updateStatus);

// Phase 6 / §4.1 — screening records (separate from interview feedback, §4.1a)
router.post("/applications/:id/screenings", recordScreeningHandler);
router.get("/applications/:id/screenings", listScreeningsHandler);

// Phase 6 / §4.2 — tenant-configurable, versioned disposition reason codes
router.get("/disposition-reasons", listDispositionReasonsHandler);
router.put("/disposition-reasons/:code", versionDispositionReasonHandler);
router.delete("/disposition-reasons/:code", deactivateDispositionReasonHandler);

// Phase 6 / §4.3 — the requisition shortlist (no count limit, §4.3)
router.post("/applications/:id/shortlist", addToShortlistHandler);
router.get("/requisitions/:requisitionId/shortlist", listShortlistHandler);
router.delete("/applications/:id/shortlist", removeFromShortlistHandler);

// Phase 6 / §4.4 — the interview packet (document ACL matrix made real)
router.post("/interviews/:id/packet", addPacketItemHandler);
router.get("/interviews/:id/packet", listPacketHandler);
router.delete("/interviews/:id/packet/:itemId", removePacketItemHandler);
router.get("/interviews/:id/packet/me", myPacketViewHandler);

// Phase 7 / §5.1–5.4 — interview scheduling lifecycle
router.put("/interviews/:id/cancel", cancelInterviewHandler);
router.post("/interviews/:id/reschedule-requests", requestRescheduleHandler);
router.put("/interviews/:id/reschedule", confirmRescheduleHandler);
router.post("/interviews/availability", availabilityHandler);
router.put("/interviews/:id/calendar-sync", markCalendarSyncHandler);
router.get("/interviews/:id/lifecycle", listLifecycleEventsHandler);

// Phase 7 / §5.5–5.5b — scorecard templates
router.get("/scorecard-templates", listTemplatesHandler);
router.post("/scorecard-templates", createTemplateHandler);
router.put("/scorecard-templates/:id", updateTemplateHandler);
router.delete("/scorecard-templates/:id", deactivateTemplateHandler);
router.post("/scorecard-templates/links", linkTemplateHandler);
router.delete("/scorecard-templates/links/:linkId", unlinkTemplateHandler);
router.get("/interviews/:id/scorecard-template", resolveTemplateHandler);

// HIRING FREEZE (Phase 4 / §2.7). Deliberately mounted at /api/recruitment/freeze
// so F-02 resolves the DEDICATED `hr.recruitment.freeze` resource, which
// RESOURCE_PREFIXES matches before the general /api/recruitment entry. Setting or
// lifting a freeze must not be reachable with an ordinary recruitment grant —
// otherwise the control an HR leader sets is one any recruiter can undo.
// A test pins the prefix ordering, because it is the only thing enforcing that.
router.get("/freeze", listHiringFreezesController);
router.post("/freeze", setHiringFreezeController);
router.post("/freeze/:id/lift", liftHiringFreezeController);

// APPROVAL MATRIX (Phase 4 / §2.5). Mounted under its own prefix for the same
// reason as the freeze: F-02 must resolve the dedicated
// `hr.recruitment.approval.matrix` resource, because configuring who has to sign
// off on a requisition is not an ordinary recruitment write.
router.get("/approval-matrix", listApprovalMatrixController);
router.get("/approval-matrix/default", getDefaultApprovalMatrixController);
router.put("/approval-matrix", setApprovalMatrixController);
router.post(
  "/approval-matrix/seed-default",
  seedDefaultApprovalMatrixController,
);

// AI ADVISORY (Phase 13 / §7). Read-only evidence surfaces: the taxonomy-
// anchored match report and the parse reconciliation preview. No state changes
// live here (§7.3) — advancing/rejecting stays with the application workflow.
router.get(
  "/ai/candidates/:candidateId/match/:requisitionId",
  matchCandidateHandler,
);
router.get(
  "/ai/candidates/:candidateId/skills/reconcile",
  reconcileSkillsHandler,
);

// PRIVACY (Phase 2.5/10). Mounted under /api/recruitment so F-02 resolves the
// resource to hr.recruitment and the action from the HTTP method — one policy
// model, no per-route declaration to drift.
router.use("/privacy", requireCandidatePrivacyAdmin);
router.post("/privacy/candidates/:id/consent", recordConsentHandler);
router.get("/privacy/candidates/:id/consent", listConsentHandler);
router.post("/privacy/dnc", recordDncHandler);
router.get("/privacy/dnc", listDncHandler);
router.put("/privacy/dnc/:id/lift", liftDncHandler);
router.post("/privacy/candidates/:id/legal-hold", placeLegalHoldHandler);
router.put(
  "/privacy/candidates/:id/legal-hold/release",
  releaseLegalHoldHandler,
);
router.put("/privacy/retention/policy", setRetentionPolicyHandler);
router.get("/privacy/retention/preview", previewRetentionHandler);
router.post("/privacy/retention/apply", applyRetentionHandler);
router.post("/privacy/candidates/:id/anonymize", anonymizeCandidateHandler);
router.post("/privacy/requests", createDataAccessRequestHandler);
router.get("/privacy/requests", listDataAccessRequestsHandler);
router.post("/privacy/requests/:id/export", exportDataAccessRequestHandler);
router.put("/privacy/requests/:id/close", closeDataAccessRequestHandler);

export default router;
