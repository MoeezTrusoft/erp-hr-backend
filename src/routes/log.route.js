import express from "express";
import { getAll, getById } from "../controllers/log.controller.js";

const router = express.Router();

router.get("/", getAll);
router.get("/:id", getById);

export default router;
