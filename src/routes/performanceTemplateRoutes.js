import express from "express";
import { createTemplate, deleteTemplate, getAllTemplates, getTemplateById, updateTemplate } from "../controllers/performanceTemplateController.js";

const router = express.Router();

router.post("/", createTemplate);
router.get("/", getAllTemplates);
router.get("/:id", getTemplateById);
router.put("/:id", updateTemplate);
router.delete("/:id", deleteTemplate);

export default router;
