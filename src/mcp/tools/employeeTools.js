import { z } from "zod";
import axios from "axios";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";

async function self(method, path, user, data) {
  const PORT = process.env.PORT || 3003;
  const headers = { "X-Internal": "true" };
  if (user?.userId) headers["X-User-ID"] = String(user.userId);
  const r = await axios({ method, url: `http://localhost:${PORT}${path}`, data, headers, timeout: 30000 });
  return r.data;
}


function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerEmployeeTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_employees_list",
    "hr://employees",
    { description: "List all employees with optional filters (page, limit, department, status)" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/employee", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_positions_list",
    "hr://positions",
    { description: "List all job positions" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/positions", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_org_chart",
    "hr://org-chart",
    { description: "Get the full organizational hierarchy chart" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/org-chart", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── EMPLOYEE TOOLS ───────────────────────────────────────────────────────

  server.tool(
    "hr_employee_get",
    "Get a specific employee by ID",
    { id: z.string().min(1).describe("Employee ID") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", `/hr/api/employee/${id}`, user.isAdmin);
      const data = await self("GET", `/api/employee/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_employee_create",
    "Create a new employee record",
    {
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.string().email(),
      phone: z.string().optional(),
      departmentId: z.string().optional(),
      positionId: z.string().optional(),
      managerId: z.string().optional(),
      hireDate: z.string().optional().describe("ISO 8601 date"),
      employmentType: z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"]).optional(),
      status: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/employee", user.isAdmin);
      const data = await self("POST", "/api/employee", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_employee_update",
    "Update an existing employee record",
    {
      id: z.string().min(1).describe("Employee ID"),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      departmentId: z.string().optional(),
      positionId: z.string().optional(),
      managerId: z.string().optional(),
      status: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/employee/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/employee/${id}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_employee_delete",
    "Delete an employee record",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/employee/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/employee/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── POSITION TOOLS ───────────────────────────────────────────────────────

  server.tool(
    "hr_position_create",
    "Create a new job position",
    {
      title: z.string().min(1),
      departmentId: z.string().optional(),
      description: z.string().optional(),
      gradeLevelId: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/positions", user.isAdmin);
      const data = await self("POST", "/api/positions", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_position_update",
    "Update a job position",
    {
      id: z.string().min(1),
      title: z.string().optional(),
      departmentId: z.string().optional(),
      description: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/positions/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/positions/${id}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_position_delete",
    "Delete a job position",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/positions/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/positions/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── EMPLOYEE LIFECYCLE ───────────────────────────────────────────────────

  server.tool(
    "hr_employee_lifecycle_create",
    "Record an employee lifecycle event (promotion, transfer, termination, etc.)",
    {
      employeeId: z.string().min(1),
      eventType: z.string().min(1).describe("e.g. PROMOTION, TRANSFER, TERMINATION"),
      effectiveDate: z.string().describe("ISO 8601 date"),
      notes: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/employee-lifecycle", user.isAdmin);
      const data = await self("POST", "/api/employee-lifecycle", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── OFFBOARDING ──────────────────────────────────────────────────────────

  server.tool(
    "hr_offboarding_create",
    "Create an offboarding checklist for an employee",
    {
      employeeId: z.string().min(1),
      lastWorkingDate: z.string().describe("ISO 8601 date"),
      reason: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/offboarding", user.isAdmin);
      const data = await self("POST", "/api/offboarding", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_offboarding_update",
    "Update offboarding details",
    {
      id: z.string().min(1),
      status: z.string().optional(),
      lastWorkingDate: z.string().optional(),
      notes: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/offboarding/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/offboarding/${id}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── EMERGENCY CONTACTS ───────────────────────────────────────────────────

  server.tool(
    "hr_emergency_contact_create",
    "Add an emergency contact for an employee",
    {
      employeeId: z.string().min(1),
      name: z.string().min(1),
      relationship: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().email().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/emergency-contacts", user.isAdmin);
      const data = await self("POST", "/api/emergency-contacts", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_emergency_contact_update",
    "Update an emergency contact",
    {
      id: z.string().min(1),
      name: z.string().optional(),
      relationship: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/emergency-contacts/update/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/emergency-contacts/update/${id}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_emergency_contact_delete",
    "Delete an emergency contact",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/emergency-contacts/delete/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/emergency-contacts/delete/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
