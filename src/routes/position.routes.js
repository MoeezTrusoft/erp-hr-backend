import express from "express";
import {
  createPositionController,
  getPositionsController,
  getPositionByIdController,
  updatePositionController,
  deletePositionController,
} from "../controllers/position.controller.js";

const router = express.Router();

router.post("/", createPositionController);
router.get("/", getPositionsController);
router.get("/:id", getPositionByIdController);
router.put("/:id", updatePositionController);
router.delete("/:id", deletePositionController);

export default router;
