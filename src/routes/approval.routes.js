import { Router } from "express";
import { HR_APPROVAL_TOOLS } from "@trusoft/contracts/hr-approval";
import { approvalController } from "../controllers/approval.controller.js";
const router = Router();
for (const [name, d] of Object.entries(HR_APPROVAL_TOOLS))
  router.post("/" + d.route, approvalController(name));
export default router;
