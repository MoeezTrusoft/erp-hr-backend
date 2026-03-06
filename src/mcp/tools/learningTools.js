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

export function registerLearningTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_training_courses_list",
    "hr://training/courses",
    { description: "List all training courses" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/training/courses", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_training_categories_list",
    "hr://training/categories",
    { description: "List all training categories" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/training/categories", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_learning_paths_list",
    "hr://learning-paths",
    { description: "List all learning paths" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/learning-paths", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_certifications_list",
    "hr://certifications",
    { description: "List all certifications" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/certifications", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_skills_list",
    "hr://skills",
    { description: "List all employee skills" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/skills", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_training_sessions_list",
    "hr://training/sessions",
    { description: "List all scheduled training sessions" },
    async (uri) => {
      const { user } = getCtx();
      const data = await self("GET", "/api/training-sessions", user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── COURSE TOOLS ─────────────────────────────────────────────────────────

  server.tool(
    "hr_training_course_create",
    "Create a new training course",
    {
      title: z.string().min(1),
      categoryId: z.string().optional(),
      description: z.string().optional(),
      duration: z.number().optional().describe("Duration in hours"),
      mandatory: z.boolean().optional(),
      externalUrl: z.string().url().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/training/courses", user.isAdmin);
      const data = await self("POST", "/api/training/courses", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_course_update",
    "Update a training course",
    {
      id: z.string().min(1),
      title: z.string().optional(),
      description: z.string().optional(),
      duration: z.number().optional(),
      status: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/training/courses/${id}`, user.isAdmin);
      const data = await self("PUT", `/api/training/courses/${id}`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_course_delete",
    "Delete a training course",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/training/courses/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/training/courses/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_category_create",
    "Create a training category",
    { name: z.string().min(1), description: z.string().optional() },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/training/categories", user.isAdmin);
      const data = await self("POST", "/api/training/categories", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── ENROLLMENT TOOLS ─────────────────────────────────────────────────────

  server.tool(
    "hr_training_enrollment_create",
    "Enroll an employee in a training course",
    {
      employeeId: z.string().min(1),
      courseId: z.string().min(1),
      dueDate: z.string().optional().describe("ISO 8601 date"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/training/enrollments", user.isAdmin);
      const data = await self("POST", "/api/training/enrollments", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_enrollment_bulk",
    "Enroll multiple employees in a course at once",
    {
      courseId: z.string().min(1),
      employeeIds: z.array(z.string()).min(1),
      dueDate: z.string().optional().describe("ISO 8601 date"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/training/enrollments/bulk", user.isAdmin);
      const data = await self("POST", "/api/training/enrollments/bulk", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_enrollment_update_status",
    "Update the status of a training enrollment",
    {
      id: z.string().min(1),
      status: z.enum(["ENROLLED", "IN_PROGRESS", "COMPLETED", "FAILED", "WITHDRAWN"]),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/training/enrollments/${id}/status`, user.isAdmin);
      const data = await self("PUT", `/api/training/enrollments/${id}/status`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_enrollment_update_progress",
    "Update training progress for an enrollment",
    {
      id: z.string().min(1),
      progress: z.number().min(0).max(100).describe("Progress percentage"),
      notes: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/training/enrollments/${id}/progress`, user.isAdmin);
      const data = await self("PUT", `/api/training/enrollments/${id}/progress`, user, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_enrollment_cancel",
    "Cancel a training enrollment",
    {
      id: z.string().min(1),
      reason: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/training/enrollments/${id}`, user.isAdmin);
      const data = await self("DELETE", `/api/training/enrollments/${id}`, user);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── CERTIFICATION TOOLS ──────────────────────────────────────────────────

  server.tool(
    "hr_certification_create",
    "Add a certification record for an employee",
    {
      employeeId: z.string().min(1),
      name: z.string().min(1),
      issuedBy: z.string().optional(),
      issuedDate: z.string().describe("ISO 8601 date"),
      expiryDate: z.string().optional().describe("ISO 8601 date"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/certifications", user.isAdmin);
      const data = await self("POST", "/api/certifications", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── LEARNING PATH TOOLS ──────────────────────────────────────────────────

  server.tool(
    "hr_learning_path_create",
    "Create a learning path",
    {
      name: z.string().min(1),
      description: z.string().optional(),
      targetRole: z.string().optional(),
      courseIds: z.array(z.string()).optional().describe("Ordered list of course IDs"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/learning-paths", user.isAdmin);
      const data = await self("POST", "/api/learning-paths", user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
