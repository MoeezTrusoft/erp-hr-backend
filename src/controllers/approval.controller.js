import {
  HR_APPROVAL_TOOLS,
  ApprovalResult,
} from "@trusoft/contracts/hr-approval";
import { approvalHandlers } from "../mcp/tools/approvalTools.js";
export const approvalController = (name) => async (req, res, next) => {
  try {
    const input = HR_APPROVAL_TOOLS[name].input.parse(req.body);
    res.json(ApprovalResult.parse(await approvalHandlers[name](input)));
  } catch (error) {
    next(error);
  }
};
