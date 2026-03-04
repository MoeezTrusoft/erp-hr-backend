import express from "express";
import * as ctrl from "../controllers/trainingSession.controller.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

const router = express.Router();

router.post("/", ctrl.createSession);
router.get("/", ctrl.listSessions);
router.put("/:id", ctrl.updateSession);
router.post("/:id/attend", ctrl.markAttendance);
router.post("/:id/recording", dynamicUpload, ctrl.uploadRecording);

export default router;
