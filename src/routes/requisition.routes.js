import express from "express";
import {
  createRequisitionController,
  getRequisitionsController,
  approveRequisitionController,
  postRequisitionController,
  deletRequisitionsController,
  getByIdRequisitionsController,
  listRequisitionAttachmentsController,
  addRequisitionAttachmentController,
  removeRequisitionAttachmentController,
  unpublishPostingController,
  withdrawRequisitionController,
  listRequisitionPostingsController,
} from "../controllers/requisition.controller.js";

const router = express.Router();

router.post("/", createRequisitionController);
router.get("/", getRequisitionsController);
// Phase 2.2 — documents hang off a requisition. Declared BEFORE "/:id" so
// "/:id/attachments" cannot be shadowed by the single-segment route.
router.get("/:id/attachments", listRequisitionAttachmentsController);
router.post("/:id/attachments", addRequisitionAttachmentController);
router.delete("/:id/attachments/:attachmentId", removeRequisitionAttachmentController);
// Phase 4 / §2.4 + §2.4a — the publication surface. All declared before the
// bare "/:id" route for the same reason the attachment routes are.
router.get("/:id/postings", listRequisitionPostingsController);
router.post("/:id/withdraw", withdrawRequisitionController);
router.post("/:id/postings/:postingId/unpublish", unpublishPostingController);
router.post("/:id/postings/channel/:channel/unpublish", unpublishPostingController);
router.get("/:id", getByIdRequisitionsController);
router.delete("/:id", deletRequisitionsController);
router.put("/approve/:id", approveRequisitionController);
router.post("/post/:id", postRequisitionController);

export default router;
