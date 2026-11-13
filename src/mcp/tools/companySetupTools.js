import {
  COMPANY_SETUP_TOOLS,
  SetupResult,
} from "@trusoft/contracts/hr-company-setup";
import {
  saveSetup,
  actSetup,
  readSetup,
  overviewSetup,
} from "../../services/company-setup/service.js";
import { advertisedObjectSchema } from "./assessmentTools.js";
import { withToolError } from "../utils/toolError.js";
import {
  readTasks,
  saveTask,
  uploadEvidence,
  readEvidence,
} from "../../services/company-setup/tracker.js";
export const setupHandlers = {
  hr_company_setup_save: saveSetup,
  hr_company_setup_action: actSetup,
  hr_company_setup_read: readSetup,
  hr_company_setup_overview: overviewSetup,
  hr_company_setup_tasks: readTasks,
  hr_company_setup_task_save: saveTask,
  hr_company_setup_evidence_upload: uploadEvidence,
  hr_company_setup_evidence_read: readEvidence,
};
export function registerCompanySetupTools(server) {
  for (const [name, d] of Object.entries(COMPANY_SETUP_TOOLS))
    server.registerTool(
      name,
      {
        description: "HR company setup: " + d.route,
        inputSchema: advertisedObjectSchema(d.input).shape,
        outputSchema: SetupResult.shape,
      },
      withToolError(async (input) => {
        const data = SetupResult.parse(await setupHandlers[name](input));
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }, name),
    );
}
