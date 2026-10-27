import {
  EMPLOYMENT_TOOLS,
  EmploymentResult,
} from "@trusoft/contracts/employment";
import { employmentHandlers } from "../mcp/tools/separationTools.js";
export const employmentController = (name) => async (req, res, next) => {
  try {
    const input = EMPLOYMENT_TOOLS[name].input.parse(
      req.method === "GET" ? req.query : req.body,
    );
    const data = EmploymentResult.parse(await employmentHandlers[name](input));
    res.json(data);
  } catch (error) {
    next(error);
  }
};
