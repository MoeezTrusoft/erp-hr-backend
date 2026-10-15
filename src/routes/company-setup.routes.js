import { Router } from "express";
import {
  COMPANY_SETUP_TOOLS,
  SetupResult,
} from "@trusoft/contracts/hr-company-setup";
import { setupHandlers } from "../mcp/tools/companySetupTools.js";
const router = Router();
for (const [name, d] of Object.entries(COMPANY_SETUP_TOOLS))
  router.post("/" + d.route, async (req, res, next) => {
    try {
      res.json(
        SetupResult.parse(await setupHandlers[name](d.input.parse(req.body))),
      );
    } catch (e) {
      next(e);
    }
  });
export default router;
