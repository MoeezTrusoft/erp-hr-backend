// src/mcp/tools/salaryComponentTools.js
//
// Payroll Setup → Salary Structure MCP tools: unified salary components
// (EARNING / DEDUCTION with FIXED / PERCENTAGE / FORMULA computation) + grade
// salary bands. All gated on the C4 payroll resource key `hr:payroll`
// (deny-by-default) via assertPermission, matching payrollTools.js.
//
// The verified tenant travels on ctx.user.tenantId (set from the signed
// service-JWT claim, never a spoofable header) and is threaded into every
// service call as `tenantId` so the service folds it via scopedWhere / the
// FORCE-RLS extension create-stamp.
import { z } from "zod";
import {
  createSalaryComponent,
  updateSalaryComponent,
  deleteSalaryComponent,
  getSalaryComponent,
  listSalaryComponents,
} from "../../services/salaryComponent.service.js";
import {
  listGradeBands,
  upsertGradeBand,
} from "../../services/gradeBand.service.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const RESOURCE = "hr:payroll";

export function registerSalaryComponentTools(server) {
  server.tool(
    "hr_salary_component_create",
    "Create a salary component (Payroll Setup → Salary Structure). value is required for FIXED/PERCENTAGE; formula is required for FORMULA. A formula may reference other component codes plus the base vars BASIC/GROSS/NET/DAYS_WORKED/WORKING_DAYS/LWP_DAYS and functions min/max/round/ceil/floor/abs/pow.",
    {
      code: z.string().min(1).describe("Unique component code within the tenant; referenced by other components' formulas (SalaryComponent.code)"),
      name: z.string().min(1).describe("Component display name (SalaryComponent.name)"),
      type: z.enum(["EARNING", "DEDUCTION"]).describe("Pay element type — EARNING | DEDUCTION (SalaryComponent.type)"),
      computation: z.enum(["FIXED", "PERCENTAGE", "FORMULA"]).describe("Computation type — FIXED (value=amount) | PERCENTAGE (value=percent 0-100) | FORMULA (formula expression)"),
      value: z.coerce.number().optional().describe("FIXED amount, or PERCENTAGE percent (0-100). Required for FIXED/PERCENTAGE; ignored for FORMULA."),
      formula: z.string().optional().describe("Formula expression (required for FORMULA). May reference other component codes + BASIC/GROSS/NET/DAYS_WORKED/WORKING_DAYS/LWP_DAYS and functions min/max/round/ceil/floor/abs/pow, e.g. \"(BASIC + HRA) * 0.1\"."),
      taxable: z.boolean().optional().describe("Whether this component is taxable (default true) — SalaryComponent.taxable"),
      active: z.boolean().optional().describe("Whether this component is active (default true) — SalaryComponent.active"),
      sortOrder: z.coerce.number().int().optional().describe("Display sort order (default 0) — SalaryComponent.sortOrder"),
      gradeLevelId: z.coerce.number().int().optional().describe("Optional GradeLevel.id scoping this component to a grade band"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await createSalaryComponent({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_salary_component_create")
  );

  server.tool(
    "hr_salary_component_update",
    "Update a salary component. Any edit bumps version and reverts the row to DRAFT. Re-validates the formula when computation/value/formula changes.",
    {
      id: z.coerce.number().int().describe("SalaryComponent.id to update (required)"),
      code: z.string().min(1).optional().describe("New unique component code (SalaryComponent.code)"),
      name: z.string().min(1).optional().describe("New display name (SalaryComponent.name)"),
      type: z.enum(["EARNING", "DEDUCTION"]).optional().describe("Pay element type — EARNING | DEDUCTION"),
      computation: z.enum(["FIXED", "PERCENTAGE", "FORMULA"]).optional().describe("Computation type — FIXED | PERCENTAGE | FORMULA"),
      value: z.coerce.number().optional().describe("FIXED amount or PERCENTAGE percent (0-100)"),
      formula: z.string().optional().describe("Formula expression (required when computation=FORMULA); may reference other component codes + BASIC/GROSS/NET/DAYS_WORKED/WORKING_DAYS/LWP_DAYS and min/max/round/ceil/floor/abs/pow"),
      taxable: z.boolean().optional().describe("Whether taxable"),
      active: z.boolean().optional().describe("Whether active"),
      sortOrder: z.coerce.number().int().optional().describe("Display sort order"),
      gradeLevelId: z.coerce.number().int().optional().describe("GradeLevel.id band scoping"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await updateSalaryComponent({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_salary_component_update")
  );

  server.tool(
    "hr_salary_component_delete",
    "Delete a salary component",
    {
      id: z.coerce.number().int().describe("SalaryComponent.id to delete"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", RESOURCE, user.isAdmin);
      const data = await deleteSalaryComponent({ tenantId: user.tenantId, id });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_salary_component_delete")
  );

  server.tool(
    "hr_salary_component_get",
    "Get a single salary component by id (includes its grade)",
    {
      id: z.coerce.number().int().describe("SalaryComponent.id to fetch"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getSalaryComponent({ tenantId: user.tenantId, id });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_salary_component_get")
  );

  server.tool(
    "hr_salary_component_list",
    "List salary components (paginated) with search / filters / sort",
    {
      q: z.string().optional().describe("Case-insensitive search over code and name"),
      type: z.enum(["EARNING", "DEDUCTION"]).optional().describe("Filter by pay element type"),
      taxable: z.boolean().optional().describe("Filter by taxable flag"),
      active: z.boolean().optional().describe("Filter by active flag"),
      gradeLevelId: z.coerce.number().int().optional().describe("Filter by GradeLevel.id"),
      status: z.enum(["DRAFT", "PUBLISHED"]).optional().describe("Filter by config status — DRAFT | PUBLISHED"),
      sortBy: z.enum(["sortOrder", "code", "name", "type"]).optional().describe("Sort field (default sortOrder)"),
      sortDir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default asc)"),
      page: z.coerce.number().int().positive().optional().describe("1-based page number (default 1)"),
      pageSize: z.coerce.number().int().positive().optional().describe("Page size (default 20, max 100)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await listSalaryComponents({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_salary_component_list")
  );

  server.tool(
    "hr_grade_band_list",
    "List grade levels with their salary bands (min/mid/max + currency) and salary-component counts",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await listGradeBands({ tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_grade_band_list")
  );

  server.tool(
    "hr_grade_band_upsert",
    "Update a grade level's salary band fields. Validates minSalary <= midSalary <= maxSalary when all present.",
    {
      id: z.coerce.number().int().describe("GradeLevel.id to update (required)"),
      minSalary: z.coerce.number().optional().describe("Band minimum salary in major units (GradeLevel.minSalary)"),
      midSalary: z.coerce.number().optional().describe("Band midpoint salary in major units (GradeLevel.midSalary)"),
      maxSalary: z.coerce.number().optional().describe("Band maximum salary in major units (GradeLevel.maxSalary)"),
      bandCurrency: z.string().optional().describe("ISO 4217 currency code for the band, e.g. PKR (GradeLevel.bandCurrency)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await upsertGradeBand({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_grade_band_upsert")
  );
}
