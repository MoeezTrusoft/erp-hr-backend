// src/mcp/tools/tagTools.js — Recruitment tag management MCP tools.
//
// List, create, upsert, deactivate tags.
// Gated on hr:recruitment and tenant-scoped.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listTags,
  createTag,
  upsertTags,
  deactivateTag,
} from "../../services/tagService.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerTagTools(server) {
  server.tool(
    "hr_tag_list",
    "List all recruitment tags with optional search and pagination",
    {
      q: z.string().optional().describe("Search by tag name"),
      page: z.number().int().positive().optional().describe("Page number"),
      limit: z.number().int().positive().optional().describe("Rows per page"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:recruitment", user.isAdmin);
      const data = await listTags({ tenantId: user.tenantId, search: args.q, page: args.page, limit: args.limit });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_tag_list")
  );

  server.tool(
    "hr_tag_create",
    "Create a new recruitment tag",
    {
      name: z.string().min(1).describe("Tag name"),
      type: z.string().optional().describe("Tag type (default: skill)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await createTag({ ...args, tenantId: user.tenantId, createdById: user.employeeId || user.userId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_tag_create")
  );

  server.tool(
    "hr_tag_upsert",
    "Create multiple tags at once (skips existing names)",
    {
      names: z.array(z.string().min(1)).min(1).describe("Tag names to create"),
    },
    withToolError(async ({ names }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:recruitment", user.isAdmin);
      const data = await upsertTags({ names, tenantId: user.tenantId, createdById: user.employeeId || user.userId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_tag_upsert")
  );

  server.tool(
    "hr_tag_deactivate",
    "Deactivate a recruitment tag",
    { id: z.union([z.number(), z.string()]).describe("Tag ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:recruitment", user.isAdmin);
      const data = await deactivateTag({ id, tenantId: user.tenantId, deletedBy: user.employeeId || user.userId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_tag_deactivate")
  );
}
