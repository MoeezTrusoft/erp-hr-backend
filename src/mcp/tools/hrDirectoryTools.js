// src/mcp/tools/hrDirectoryTools.js: hr_identity_resolve + hr_skill_holders_list
// (contracts 0.15.0 @trusoft/contracts/mcp/hr HR_TOOLS).
//
// Permission: both tools are gated on the contracts permission
// `hr.employee.read`, which is the dotted form of the RBAC resource
// `hr:employee` + VIEW that RBAC already seeds (erp-rbac-backend prisma/seed.js
// HR resources; same gate as hr_skill_list / hr_employee_skills_list). No new
// RBAC permission key is introduced, so nothing returns a permanent 403.
// assertPermission maps ("GET", "hr:employee") to "hr.employee.read" for the
// dotted scope array and to hr:employee VIEW for the legacy blob.
import { HR_TOOLS, HrIdentityResolveInput, HrSkillHoldersListInput } from "@trusoft/contracts/mcp/hr";

import { getCtx } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveEmployeeIdentity, listSkillHolders } from "../../services/hr-directory.service.js";

export const HR_DIRECTORY_PERMISSION = { method: "GET", resource: "hr:employee" };

const definitions = Object.fromEntries(HR_TOOLS.map((tool) => [tool.name, tool]));

// Advertised shapes: the contracts objects without their cross-field refine
// (the handler re-parses the raw input with the full contracts schema).
const advertised = {
  hr_identity_resolve: HrIdentityResolveInput.shape,
  hr_skill_holders_list: HrSkillHoldersListInput.shape,
};

export const hrDirectoryHandlers = {
  hr_identity_resolve: resolveEmployeeIdentity,
  hr_skill_holders_list: listSkillHolders,
};

export function registerHrDirectoryTools(server) {
  for (const [name, handler] of Object.entries(hrDirectoryHandlers)) {
    const definition = definitions[name];
    if (!definition) throw new Error(`contracts HR_TOOLS is missing ${name}`);
    server.registerTool(
      name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: advertised[name],
        annotations: {
          title: definition.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      withToolError(async (args) => {
        const { user, permissions } = getCtx();
        assertPermission(permissions, HR_DIRECTORY_PERMISSION.method, HR_DIRECTORY_PERMISSION.resource, user.isAdmin);
        const data = await handler(args, { tenantId: user.tenantId });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }, name),
    );
  }
}

