// src/mcp/tools/positionMgmtTools.js — Position Management MCP tools.
//
// Read/export surface for the position-management screens:
//   hr_positions_manage_list  — enhanced, paginated management list
//   hr_position_manage_get     — single position detail + filled ratio + roster
//   hr_positions_export        — CSV/PDF export of the management view
//
// Create / edit / deactivate already exist and are NOT duplicated here:
//   hr_position_create        (employeeTools.js → createPosition)
//   hr_position_update        (employeeTools.js → updatePosition)
//   hr_position_status_update (employeeTools.js → updatePositionStatus)
//
// Auth: every handler runs getCtx() → assertPermission(GET, "hr:employee") →
// service(query, user.tenantId), matching the existing hr_positions_list tool.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listManagedPositions,
  getManagedPosition,
  exportManagedPositions,
} from "../../services/positionMgmt.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// Shared list/filter shape for the management list + export. `band` is accepted
// now and filtered from the position meta blob until the column lands.
const manageListShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  q: z.string().optional().describe("Search title or job code"),
  status: z.string().optional().describe("Filter: Active | Inactive"),
  band: z.string().optional().describe("Filter by band (post-migration; meta-blob today)"),
  sort: z.enum(["title", "createdAt", "status"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
};

export function registerPositionMgmtTools(server) {
  server.tool(
    "hr_positions_manage_list",
    "Enhanced position-management list: title, department, band, filled/openings ratio, status, job description, responsibilities, requirements. Supports pagination, search (title/jobCode), status/band filters, and sort (title|createdAt|status).",
    manageListShape,
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const query = { page: 1, pageSize: 10, ...args };
      const data = await listManagedPositions(query, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_positions_manage_list")
  );

  server.tool(
    "hr_position_manage_get",
    "Get a single position with full management detail (band, filled/openings ratio, status, job description, responsibilities, requirements) plus the list of current employees in it (id, name).",
    { id: z.string().min(1).describe("Position ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await getManagedPosition(id, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_position_manage_get")
  );

  server.tool(
    "hr_positions_export",
    "Export the position-management view (all rows matching the filters) as CSV or PDF. Columns: Title, Department, Band, Filled/Openings, Status, Created. Returns { format, fileName, mimeType, count, base64 }.",
    {
      format: z.enum(["csv", "pdf"]).default("csv"),
      q: z.string().optional(),
      status: z.string().optional(),
      band: z.string().optional(),
      sort: z.enum(["title", "createdAt", "status"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    withToolError(async ({ format, ...query }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await exportManagedPositions(query, user.tenantId, format);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_positions_export")
  );
}
