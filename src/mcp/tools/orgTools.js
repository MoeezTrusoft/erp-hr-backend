import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { listDepartments, getDepartmentById } from "../../services/rbac.client.js";

// Org-structure reads that HR proxies FROM RBAC. Departments live in RBAC
// (Company → Department); HR calls RBAC over the internal service plane
// (rbac.client) with the acting user's identity forwarded, so results are
// scoped to the caller's company. These give the FE a single HR-side entry
// point to fetch the authoritative departments (e.g. to populate a
// requisition/pipeline department dropdown) without talking to RBAC directly.

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerOrgTools(server) {
  server.tool(
    "hr_departments_list",
    "List the company's departments from RBAC (the authoritative org source), scoped to the caller's company. Use to populate department dropdowns (departmentId elsewhere = RBAC Department.id).",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const departments = await listDepartments();
      return { content: [{ type: "text", text: JSON.stringify({ departments, total: departments.length }) }] };
    }, "hr_departments_list")
  );

  server.tool(
    "hr_department_get",
    "Get a single RBAC department by id (tenant-scoped to the caller's company). Returns { department: { id, name, description } | null }.",
    {
      id: z.union([z.string(), z.number()]).describe("RBAC Department id (references RBAC Department.id)"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const department = await getDepartmentById(id);
      return { content: [{ type: "text", text: JSON.stringify({ department }) }] };
    }, "hr_department_get")
  );
}
