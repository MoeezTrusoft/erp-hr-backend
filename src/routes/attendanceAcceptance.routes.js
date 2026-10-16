import { Router } from "express";
import { ACCEPTANCE_TOOLS } from "@trusoft/contracts/attendance-acceptance";
import { acceptanceCommand } from "../services/attendance-acceptance/service.js";
const router = Router();
for (const [name, d] of Object.entries(ACCEPTANCE_TOOLS))
  router.post("/" + d.route, async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(await acceptanceCommand(name, req.body));
    } catch (e) {
      next(e);
    }
  });
export default router;
