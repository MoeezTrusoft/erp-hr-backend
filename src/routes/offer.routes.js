import express from "express";
import * as ctrl from "../controllers/offer.controller.js";
import dynamicUpload from "../middlewares/upload.middleware.js";
import { idempotency } from "../middlewares/idempotency.middleware.js";

const router = express.Router();

// Phase 14 — replay protection on offer creation (an offer duplicated by a
// network retry is a compliance incident, not just a data bug). Opt-in per
// request via Idempotency-Key; namespaced by the verified tenant.
router.post("/", idempotency(), ctrl.createOffer);
router.get("/", ctrl.listOffers);
router.get("/:id", ctrl.getOffer);
router.put("/:id/approve", ctrl.approve);
router.put("/:id/send", ctrl.sendOffer);
router.put("/:id/respond", ctrl.respondOffer);
router.get("/:id/handoff", ctrl.getHandoff);
// Operator retry for a FAILED accepted-offer handoff (idempotent).
router.post("/:id/handoff/retry", ctrl.retryHandoff);
router.post("/:id/letter", dynamicUpload, ctrl.uploadOfferLetter);

export default router;
