import {
  HR_APPROVAL_TOOLS,
  ApprovalResult,
} from "@trusoft/contracts/hr-approval";
import {
  listApprovals,
  readApproval,
  previewApproval,
  submitApproval,
  actApproval,
} from "../../services/approval/service.js";
import { advertisedObjectSchema } from "./assessmentTools.js";
import { withToolError } from "../utils/toolError.js";
export const approvalHandlers = {
  hr_approval_preview: previewApproval,
  hr_approval_list: listApprovals,
  hr_approval_read: readApproval,
  hr_approval_submit: submitApproval,
  hr_approval_action: actApproval,
};
export function registerApprovalTools(server) {
  for (const [name, d] of Object.entries(HR_APPROVAL_TOOLS))
    server.registerTool(
      name,
      {
        description: `HR approval workflow: ${d.route}`,
        inputSchema: advertisedObjectSchema(d.input).shape,
        outputSchema: ApprovalResult.shape,
      },
      withToolError(async (raw) => {
        const data = ApprovalResult.parse(
          await approvalHandlers[name](d.input.parse(raw)),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }, name),
    );
}
