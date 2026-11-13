// src/mcp/tools/regionTools.js — Region management MCP tools.
//
// Five tools for Region CRUD, all gated on hr:holiday and tenant-scoped.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  getRegions,
  getRegionById,
  createRegion,
  updateRegion,
  deleteRegion,
} from "../../services/holiday.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerRegionTools(server) {
  server.tool(
    "hr_region_list",
    "List all regions with optional search and pagination",
    {
      q: z.string().optional().describe("Search by region name"),
      page: z.number().int().positive().optional().describe("Page number (default 1)"),
      pageSize: z.number().int().positive().optional().describe("Rows per page (default 20)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:holiday", user.isAdmin);
      const data = await getRegions(args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_region_list")
  );

  server.tool(
    "hr_region_get",
    "Get a single region by ID",
    { id: z.union([z.number(), z.string()]).describe("Region ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:holiday", user.isAdmin);
      const data = await getRegionById(id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_region_get")
  );

  server.tool(
    "hr_region_create",
    "Create a new region",
    {
      name: z.string().min(1).describe("Region name"),
      code: z.string().optional().describe("Region code"),
      description: z.string().optional().describe("Region description"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:holiday", user.isAdmin);
      const data = await createRegion(args, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_region_create")
  );

  server.tool(
    "hr_region_update",
    "Update an existing region",
    {
      id: z.union([z.number(), z.string()]).describe("Region ID"),
      name: z.string().optional().describe("Region name"),
      code: z.string().optional().describe("Region code"),
      description: z.string().optional().describe("Region description"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:holiday", user.isAdmin);
      const result = await updateRegion(id, user.employeeId || user.userId, data);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_region_update")
  );

  server.tool(
    "hr_region_delete",
    "Delete a region",
    { id: z.union([z.number(), z.string()]).describe("Region ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:holiday", user.isAdmin);
      const data = await deleteRegion(id, user.employeeId || user.userId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_region_delete")
  );
}
