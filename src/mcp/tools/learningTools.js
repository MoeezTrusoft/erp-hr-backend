import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  mcpBulkTrainingEnrollment,
  mcpCancelTrainingEnrollment,
  mcpCreateCertification,
  mcpCreateLearningPath,
  mcpCreateTrainingCategory,
  mcpCreateTrainingCourse,
  mcpCreateTrainingEnrollment,
  mcpDeleteTrainingCourse,
  mcpListCertifications,
  mcpListLearningPaths,
  mcpListSkills,
  mcpListTrainingCategories,
  mcpListTrainingCourses,
  mcpListTrainingSessions,
  mcpUpdateTrainingCourse,
  mcpUpdateTrainingEnrollmentProgress,
  mcpUpdateTrainingEnrollmentStatus,
} from "../controllers/learningMcpController.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerLearningTools(server) {
  server.resource(
    "hr_training_courses_list",
    "hr://training/courses",
    { description: "List all training courses" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListTrainingCourses(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_training_categories_list",
    "hr://training/categories",
    { description: "List all training categories" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListTrainingCategories(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_learning_paths_list",
    "hr://learning-paths",
    { description: "List all learning paths" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListLearningPaths(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_certifications_list",
    "hr://certifications",
    { description: "List all certifications" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListCertifications(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_skills_list",
    "hr://skills",
    { description: "List all employee skills" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListSkills(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_training_sessions_list",
    "hr://training/sessions",
    { description: "List all scheduled training sessions" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListTrainingSessions(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

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
      const data = await mcpCreateTrainingCourse(user, args);
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
      const data = await mcpUpdateTrainingCourse(user, id, rest);
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
      const data = await mcpDeleteTrainingCourse(user, id);
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
      const data = await mcpCreateTrainingCategory(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

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
      const data = await mcpCreateTrainingEnrollment(user, args);
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
      const data = await mcpBulkTrainingEnrollment(user, args);
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
      const data = await mcpUpdateTrainingEnrollmentStatus(user, id, rest);
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
      const data = await mcpUpdateTrainingEnrollmentProgress(user, id, rest);
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
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", `/hr/api/training/enrollments/${id}`, user.isAdmin);
      const data = await mcpCancelTrainingEnrollment(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

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
      const data = await mcpCreateCertification(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

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
      const data = await mcpCreateLearningPath(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
