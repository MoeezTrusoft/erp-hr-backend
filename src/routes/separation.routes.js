import { Router } from "express";
import { EMPLOYMENT_TOOLS } from "@trusoft/contracts/employment";
import { employmentController } from "../controllers/separation.controller.js";
const router = Router();
for (const [name, definition] of Object.entries(EMPLOYMENT_TOOLS)) {
  router.post("/" + definition.route, employmentController(name));
  if (name === "hr_separation_list")
    router.get("/" + definition.route, employmentController(name));
}
export default router;
