import express from "express";
import {
  saveLayoutController,
 // getLayoutController
} from "../controllers/dashboardLayout.controller.js";

const router = express.Router();

router.post("/", saveLayoutController);
//router.get("/:userId", getLayoutController);

export default router;