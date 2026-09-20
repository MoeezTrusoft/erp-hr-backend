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
  listRequisitionQuestionsController,
  createRequisitionQuestionController,
  updateRequisitionQuestionController,
  deactivateRequisitionQuestionController,
  reorderRequisitionQuestionsController,
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

// Phase 5 / §3.5 — application-question CRUD on the requisition (the public
// intake form's schema).
router.get("/:id/questions", listRequisitionQuestionsController);
router.post("/:id/questions", createRequisitionQuestionController);
router.put("/:id/questions/:questionId", updateRequisitionQuestionController);
router.delete("/:id/questions/:questionId", deactivateRequisitionQuestionController);
router.put("/:id/questions/order", reorderRequisitionQuestionsController);
router.get("/:id", getByIdRequisitionsController);
router.delete("/:id", deletRequisitionsController);
router.put("/approve/:id", approveRequisitionController);
router.post("/post/:id", postRequisitionController);

export default router;
