import { z } from "zod";
import { mcpCtx } from "../context.js";
import { withToolError } from "../utils/toolError.js";
import {
  listProvisioning,
  fulfillProvisioning,
} from "../../services/onboardingProvisioning.service.js";
// Services verify both capability and row ownership; a broad IT grant never
// exposes HR onboarding records or another technician's requests.
export function registerOnboardingProvisioningTools(server) {
  server.tool(
    "hr_onboarding_provisioning_requests_list",
    "List HR provisioning requests or the verified IT employee’s assigned account and equipment requests",
    {
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
      status: z.enum(["PENDING", "FULFILLED"]).optional(),
      category: z.enum(["IT_ACCESS_SETUP", "WORKSPACE_EQUIPMENT"]).optional(),
      checklistId: z.number().int().positive().optional(),
    },
    withToolError(
      async (args) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await listProvisioning(args, mcpCtx.getStore()?.user?.tenantId),
            ),
          },
        ],
      }),
      "hr_onboarding_provisioning_requests_list",
    ),
  );
  server.tool(
    "hr_onboarding_provisioning_fulfill",
    "Record completed account or equipment provisioning with a ticket, account identifier, or asset reference. Never include passwords.",
    {
      taskId: z.number().int().positive(),
      expectedVersion: z.number().int().nonnegative(),
      reference: z.string().trim().min(1).max(2000),
    },
    withToolError(
      async (args) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await fulfillProvisioning(
                args,
                mcpCtx.getStore()?.user?.tenantId,
              ),
            ),
          },
        ],
      }),
      "hr_onboarding_provisioning_fulfill",
    ),
  );
}
