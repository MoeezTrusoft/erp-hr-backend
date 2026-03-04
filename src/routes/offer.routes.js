import express from "express";
import * as ctrl from "../controllers/offer.controller.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

const router = express.Router();

router.post("/", ctrl.createOffer);
router.get("/", ctrl.listOffers);
router.get("/:id", ctrl.getOffer);
router.put("/:id/send", ctrl.sendOffer);
router.put("/:id/respond", ctrl.respondOffer);
router.post("/:id/letter", dynamicUpload, ctrl.uploadOfferLetter);

export default router;
