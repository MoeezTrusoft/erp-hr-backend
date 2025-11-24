import { Router } from "express";
import {
  create,
  getAll,
  getById,
  update,
  remove
} from "../controllers/emergencyContacts.controller.js";

const router = Router();

router.post("/", create);
router.get("/", getAll);
router.get("/:id", getById);
router.put("/update/:id", update);
router.delete("/delete/:id", remove);

export default router;
