import {
  EMPLOYMENT_TOOLS,
  EmploymentResult,
} from "@trusoft/contracts/employment";
import {
  configureEmployeeCode,
  convertCategory,
  employeeCodeStatus,
} from "../../services/employee-code.service.js";
import {
  configureSeparation,
  createSeparation,
  editSeparation,
  revertSeparation,
  separationAction,
  recommendSeparation,
  verifySeparation,
  decideSeparation,
  noticeAction,
} from "../../services/separation/service.js";
import {
  replacementAction,
  ktAction,
  assetAction,
  accessAction,
  clearanceAction,
  interviewAction,
  settlementAction,
} from "../../services/separation/workstreams.js";
import { syncSource } from "../../services/separation/integrations.js";
import { listSeparations } from "../../services/separation/read.js";
import { advertisedObjectSchema } from "./assessmentTools.js";
import { withToolError } from "../utils/toolError.js";
export const employmentHandlers = {
  hr_employee_code_status: employeeCodeStatus,
  hr_employee_code_configure: configureEmployeeCode,
  hr_employee_category_convert: convertCategory,
  hr_separation_configure: configureSeparation,
  hr_separation_list: listSeparations,
  hr_separation_create: createSeparation,
  hr_separation_edit: editSeparation,
  hr_separation_revert: revertSeparation,
  hr_separation_action: separationAction,
  hr_separation_manager_recommend: recommendSeparation,
  hr_separation_hr_verify: verifySeparation,
  hr_separation_decide: decideSeparation,
  hr_separation_notice: noticeAction,
  hr_separation_replacement: replacementAction,
  hr_separation_kt: ktAction,
  hr_separation_asset: assetAction,
  hr_separation_access: accessAction,
  hr_separation_clearance: clearanceAction,
  hr_separation_interview: interviewAction,
  hr_separation_settlement: settlementAction,
  hr_separation_source_sync: syncSource,
};
export function registerSeparationTools(server) {
  for (const [name, definition] of Object.entries(EMPLOYMENT_TOOLS))
    server.registerTool(
      name,
      {
        description: `HR employee management: ${definition.route}`,
        inputSchema: advertisedObjectSchema(definition.input).shape,
        outputSchema: EmploymentResult.shape,
      },
      withToolError(async (input) => {
        const data = EmploymentResult.parse(
          await employmentHandlers[name](input),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }, name),
    );
}
