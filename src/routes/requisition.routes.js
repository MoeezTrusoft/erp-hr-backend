import express from "express";
import {
  createRequisitionController,
  getRequisitionsController,
  approveRequisitionController,
  postRequisitionController,
  deletRequisitionsController,
  getByIdRequisitionsController,
} from "../controllers/requisition.controller.js";

const router = express.Router();

router.post("/", createRequisitionController);
router.get("/", getRequisitionsController);
router.get("/:id", getByIdRequisitionsController);
router.delete("/:id", deletRequisitionsController);
router.put("/approve/:id", approveRequisitionController);
router.post("/post/:id", postRequisitionController);

export default router;
