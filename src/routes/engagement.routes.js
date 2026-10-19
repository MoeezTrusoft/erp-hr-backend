// src/routes/engagement.routes.js — REST parity for the Engagement Context
// Engine (ARCH-05 §12: REST and MCP share one handler map). Authorization is
// resolved by routeAuthorization.middleware.js from the "/api/hr/engagement"
// resource prefix (hr.engagement.read|create|update); the handler re-asserts
// the same entitlement, so parity holds on both surfaces.
import { Router } from "express";

import { handlers } from "../services/engagement/handlers.js";

const call = (name, pick) => async (req, res, next) => {
  try {
    const raw = pick ? pick(req) : { ...req.query, ...req.body };
    res.json({ success: true, data: await handlers[name](raw) });
  } catch (error) {
    next(error);
  }
};

const router = Router();

// Parties
router.get("/parties", call("hr_engagement_party_list", (req) => ({ ...req.query, limit: req.query.limit ? Number(req.query.limit) : undefined, includeMerged: req.query.includeMerged === "true" })));
router.post("/parties", call("hr_engagement_party_create", (req) => req.body));
router.post("/parties/resolve", call("hr_engagement_party_resolve", (req) => req.body));
router.get("/parties/:partyId", call("hr_engagement_party_get", (req) => ({ partyId: req.params.partyId })));
router.put("/parties/:partyId", call("hr_engagement_party_update", (req) => ({ ...req.body, partyId: req.params.partyId })));
router.put("/parties/:partyId/identities", call("hr_engagement_identity_link", (req) => ({ ...req.body, partyId: req.params.partyId })));
router.put("/parties/:partyId/merge", call("hr_engagement_party_merge", (req) => ({ ...req.body, targetPartyId: req.params.partyId })));

// Communication intake
router.post("/events", call("hr_engagement_event_ingest", (req) => req.body));
router.get("/parties/:partyId/events", call("hr_engagement_event_list", (req) => ({ ...req.query, partyId: req.params.partyId, limit: req.query.limit ? Number(req.query.limit) : undefined })));
router.post("/parties/:partyId/thread-import", call("hr_engagement_thread_import", (req) => ({ ...req.body, partyId: req.params.partyId })));

// Profile and facts
router.get("/parties/:partyId/profile", call("hr_engagement_profile_get", (req) => ({ partyId: req.params.partyId })));
router.put("/parties/:partyId/profile/refresh", call("hr_engagement_profile_refresh", (req) => ({ ...req.body, partyId: req.params.partyId })));
router.get("/parties/:partyId/facts", call("hr_engagement_fact_list", (req) => ({ ...req.query, partyId: req.params.partyId, limit: req.query.limit ? Number(req.query.limit) : undefined })));
router.put("/facts/:factId", call("hr_engagement_fact_update", (req) => ({ ...req.body, factId: req.params.factId })));

// Content generation
router.post("/documents", call("hr_engagement_document_generate", (req) => req.body));
router.get("/documents", call("hr_engagement_document_list", (req) => ({ ...req.query, limit: req.query.limit ? Number(req.query.limit) : undefined })));
router.get("/documents/:documentId", call("hr_engagement_document_get", (req) => ({ documentId: req.params.documentId })));
router.put("/documents/:documentId", call("hr_engagement_document_update", (req) => ({ ...req.body, documentId: req.params.documentId })));
router.put("/documents/:documentId/transition", call("hr_engagement_document_transition", (req) => ({ ...req.body, documentId: req.params.documentId })));

// PM projects
router.post("/project-links", call("hr_engagement_project_propose", (req) => req.body));
router.get("/project-links", call("hr_engagement_project_link_list", (req) => ({ ...req.query, limit: req.query.limit ? Number(req.query.limit) : undefined })));
router.put("/project-links/:linkId/confirm", call("hr_engagement_project_confirm", (req) => ({ ...req.body, linkId: req.params.linkId })));
router.put("/project-links/:linkId/sync", call("hr_engagement_project_sync", (req) => ({ ...req.body, linkId: req.params.linkId })));

// Q&A and catalog
router.get("/parties/:partyId/ask", call("hr_engagement_context_ask", (req) => ({ ...req.query, partyId: req.params.partyId, eventLimit: req.query.eventLimit ? Number(req.query.eventLimit) : undefined })));
router.get("/catalog", call("hr_engagement_catalog_get", () => ({})));

export default router;
