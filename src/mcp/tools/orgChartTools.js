// src/mcp/tools/orgChartTools.js — Organization Chart MCP tools.
//
// Two tools, both gated on hr:employee VIEW and tenant-scoped via the verified
// user.tenantId (RBAC Company.uuid), mirroring hr_employees_list / _export:
//   hr_org_chart_departments — departments (head + members), optional q search.
//   hr_org_chart_export       — flat org hierarchy as CSV / PDF / PNG.
//
// The department/export views are read straight from orgChartView.service.js
// (no controller layer needed) inside withToolError handlers, following the
// getCtx → assertPermission → service(..., user.tenantId) pattern.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { exportRows } from "../../lib/export.util.js";
import {
  getDepartmentView,
  getOrgChartRows,
  orgChartToPNG,
} from "../../services/orgChartView.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

// Flat-table columns shared by the CSV and PDF export renderers.
const ORG_EXPORT_COLUMNS = [
  { key: "name", header: "Employee" },
  { key: "role", header: "Position / Role", value: (r) => r.role || "-" },
  { key: "department", header: "Department", value: (r) => r.department || "-" },
  { key: "manager", header: "Manager", value: (r) => r.manager || "-" },
  { key: "status", header: "Status" },
];

const today = () => new Date().toISOString().slice(0, 10);

export function registerOrgChartTools(server) {
  server.tool(
    "hr_org_chart_departments",
    "Org chart grouped by department: each department returns its resolved head plus members [{ id, name, role, status }]. Sorted by department name; optional q filters employees by name/role.",
    {
      q: z.string().optional().describe("Filter employees by name or position/role across all departments"),
    },
    withToolError(async ({ q }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const data = await getDepartmentView(user.tenantId, { q });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
    }, "hr_org_chart_departments")
  );

  server.tool(
    "hr_org_chart_export",
    "Export the org hierarchy (employee, position/role, department, manager, status) as a flat table. csv/pdf use the shared serializer; png renders a boxes-and-lines chart indented by reporting depth. Returns { format, fileName, mimeType, count, base64 }.",
    {
      format: z.enum(["csv", "pdf", "png"]).default("csv"),
      q: z.string().optional().describe("Filter employees by name or position/role"),
    },
    withToolError(async ({ format, q }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:employee", user.isAdmin);
      const rows = await getOrgChartRows(user.tenantId, { q });

      let mimeType;
      let ext;
      let buffer;
      if (format === "png") {
        buffer = await orgChartToPNG(rows);
        mimeType = "image/png";
        ext = "png";
      } else {
        const out = await exportRows(format, {
          title: "Organization Chart",
          subtitle: `${rows.length} employee(s) — generated ${today()}`,
          columns: ORG_EXPORT_COLUMNS,
          rows,
        });
        mimeType = out.mimeType;
        ext = out.ext;
        buffer = out.buffer;
      }

      const data = {
        format,
        fileName: `org-chart-${today()}.${ext}`,
        mimeType,
        count: rows.length,
        base64: buffer.toString("base64"),
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_org_chart_export")
  );
}
