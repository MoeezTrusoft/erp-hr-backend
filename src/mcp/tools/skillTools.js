// src/mcp/tools/skillTools.js — Skills catalog + Employee skill assignment MCP tools.
//
// Skills: list + create. Employee skills: list + add + remove.
// Gated on hr:employee for skills, hr:employee for employee skills.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listSkills,
  createSkill,
  getEmployeeSkills,
  addEmployeeSkill,
  removeEmployeeSkill,
} from "../../services/employeeSkill.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerSkillTools(server) {
  // ── Skills Catalog ────────────────────────────────────────────────────
  server.tool(
    "hr_skill_list",
    "List all skills in the catalog",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await listSkills(user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_skill_list")
  );

  server.tool(
    "hr_skill_create",
    "Create a new skill in the catalog",
    {
      name: z.string().min(1).describe("Skill name"),
      category: z.string().optional().describe("Skill category"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await createSkill({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_skill_create")
  );

  // ── Employee Skills ───────────────────────────────────────────────────
  server.tool(
    "hr_employee_skills_list",
    "List skills assigned to an employee",
    { employeeId: z.union([z.number(), z.string()]).describe("Employee ID") },
    withToolError(async ({ employeeId }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await getEmployeeSkills(employeeId, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_skills_list")
  );

  server.tool(
    "hr_employee_skill_add",
    "Add a skill to an employee",
    {
      employeeId: z.union([z.number(), z.string()]).describe("Employee ID"),
      skillId: z.union([z.number(), z.string()]).describe("Skill ID"),
      proficiency: z.string().optional().describe("Proficiency level"),
      verified: z.boolean().optional().describe("Whether skill is verified"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:employee", user.isAdmin);
      const data = await addEmployeeSkill({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_skill_add")
  );

  server.tool(
    "hr_employee_skill_remove",
    "Remove a skill from an employee",
    { id: z.union([z.number(), z.string()]).describe("EmployeeSkill record ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:employee", user.isAdmin);
      const data = await removeEmployeeSkill(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_employee_skill_remove")
  );
}
