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
} from "../controllers/requisition.controller.js";

const router = express.Router();

router.post("/", createRequisitionController);
router.get("/", getRequisitionsController);
// Phase 2.2 — documents hang off a requisition. Declared BEFORE "/:id" so
// "/:id/attachments" cannot be shadowed by the single-segment route.
router.get("/:id/attachments", listRequisitionAttachmentsController);
router.post("/:id/attachments", addRequisitionAttachmentController);
router.delete("/:id/attachments/:attachmentId", removeRequisitionAttachmentController);
router.get("/:id", getByIdRequisitionsController);
router.delete("/:id", deletRequisitionsController);
router.put("/approve/:id", approveRequisitionController);
router.post("/post/:id", postRequisitionController);

export default router;
