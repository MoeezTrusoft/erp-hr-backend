import { Router } from "express";
import { APPRAISAL_TOOLS } from "@trusoft/contracts/performance-appraisals";
import { handlers } from "../services/appraisals/index.js";
const router = Router();
for (const [name, [, schema]] of Object.entries(APPRAISAL_TOOLS)) {
  router.post("/" + name.replace("hr_appraisal_", ""), async (req, res) => {
    try {
      const input = { ...req.body };
      const changing = schema.shape?.expectedVersion;
      if (changing) {
        const match = req.get("If-Match");
        if (!match)
          return res.status(428).json({
            code: "EXPECTED_VERSION_REQUIRED",
            message: "If-Match is required",
          });
        if (!/^(?:\d+|"\d+")$/.test(match))
          return res
            .status(422)
            .json({ code: "VALIDATION_FAILED", message: "Invalid If-Match" });
        const headerVersion = Number(match.replaceAll('"', ""));
        if (
          input.expectedVersion !== undefined &&
          input.expectedVersion !== headerVersion
        )
          return res.status(422).json({
            code: "VALIDATION_FAILED",
            message: "Version headers and body disagree",
          });
        input.expectedVersion = headerVersion;
      }
      const result = await handlers[name](schema.parse(input));
      if (result.version !== undefined) res.set("ETag", `"${result.version}"`);
      return res.status(result.jobId ? 202 : 200).json(result);
    } catch (error) {
      const validation = error.name === "ZodError";
      const status = validation ? 422 : error.status || 500;
      return res.status(status).json({
        code: validation ? "VALIDATION_FAILED" : error.code || "INTERNAL_ERROR",
        message:
          status >= 500
            ? "Unable to complete the request"
            : validation
              ? "Check the supplied fields"
              : error.message,
        correlationId: req.correlationId,
        ...(validation
          ? {
              fields: error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            }
          : {}),
        ...(error.details ? { details: error.details } : {}),
      });
    }
  });
}
export default router;
