import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  mcpBulkTrainingEnrollment,
  mcpCancelTrainingEnrollment,
  mcpCreateCertification,
  mcpGetCertification,
  mcpUpdateCertification,
  mcpDeleteCertification,
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
      categoryId: z.string().min(1).describe("Training category id (references TrainingCategory.id; required NOT NULL FK)"),
      description: z.string().optional(),
      durationHours: z.number().int().positive().optional().describe("Course duration in hours (TrainingCourse.durationHours)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:learning", user.isAdmin);
      const data = await mcpCreateTrainingCourse(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_course_update",
    "Update a training course",
    {
      id: z.string().min(1).describe("Training course id (references TrainingCourse.id)"),
      title: z.string().optional(),
      description: z.string().optional(),
      durationHours: z.number().int().positive().optional().describe("Course duration in hours (TrainingCourse.durationHours)"),
      status: z.enum(["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]).optional().describe("Course status — one of DRAFT | ACTIVE | COMPLETED | CANCELLED"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:learning", user.isAdmin);
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
      assertPermission(permissions, "DELETE", "hr:learning", user.isAdmin);
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
      assertPermission(permissions, "POST", "hr:learning", user.isAdmin);
      const data = await mcpCreateTrainingCategory(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_enrollment_create",
    "Enroll an employee in a training course",
    {
      employeeId: z.string().min(1).describe("Employee to enroll (references Employee.id)"),
      courseId: z.string().min(1).describe("Training course id (references TrainingCourse.id)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:learning", user.isAdmin);
      const data = await mcpCreateTrainingEnrollment(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_enrollment_bulk",
    "Enroll multiple employees in a course at once",
    {
      courseId: z.string().min(1).describe("Training course id (references TrainingCourse.id)"),
      employeeIds: z.array(z.string()).min(1).describe("Employee ids to enroll (each references Employee.id)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:learning", user.isAdmin);
      const data = await mcpBulkTrainingEnrollment(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_enrollment_update_status",
    "Update the status of a training enrollment",
    {
      id: z.string().min(1).describe("Training enrollment id (references TrainingEnrollment.id)"),
      status: z.enum(["ENROLLED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).describe("Enrollment status — one of ENROLLED | IN_PROGRESS | COMPLETED | CANCELLED"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:learning", user.isAdmin);
      const data = await mcpUpdateTrainingEnrollmentStatus(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_enrollment_update_progress",
    "Update training progress for an enrollment",
    {
      id: z.string().min(1).describe("Training enrollment id (references TrainingEnrollment.id)"),
      progress: z.number().min(0).max(100).describe("Progress percentage (0-100)"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:learning", user.isAdmin);
      const data = await mcpUpdateTrainingEnrollmentProgress(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_training_enrollment_cancel",
    "Cancel a training enrollment",
    {
      id: z.string().min(1).describe("Training enrollment id (references TrainingEnrollment.id)"),
    },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:learning", user.isAdmin);
      const data = await mcpCancelTrainingEnrollment(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_certification_create",
    "Add a certification record for an employee",
    {
      employeeId: z.string().min(1).describe("Employee the certification belongs to (references Employee.id)"),
      name: z.string().min(1).describe("Certification name (persisted to Certification.name, NOT NULL)"),
      issuedBy: z.string().optional().describe("Issuing authority/body"),
      issuedDate: z.string().describe("ISO 8601 date YYYY-MM-DD — issue date (Certification.issuedAt)"),
      expiryDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD — expiry date"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:learning", user.isAdmin);
      const data = await mcpCreateCertification(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_certifications_list",
    "List certification records (optionally filtered by employee), paginated",
    {
      employeeId: z.string().optional().describe("Filter to one employee (references Employee.id); omit for all"),
      page: z.coerce.number().int().positive().optional().describe("Page number (default 1)"),
      limit: z.coerce.number().int().positive().max(100).optional().describe("Page size (default 20, max 100)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:learning", user.isAdmin);
      const data = await mcpListCertifications(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_certification_get",
    "Get a single certification record by id",
    { id: z.string().min(1).describe("Certification id (references Certification.id)") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:learning", user.isAdmin);
      const data = await mcpGetCertification(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_certification_update",
    "Update a certification record",
    {
      id: z.string().min(1).describe("Certification id (references Certification.id)"),
      name: z.string().min(1).optional().describe("Certification name (Certification.name)"),
      issuedBy: z.string().optional().describe("Issuing authority/body"),
      issuedDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD — issue date (Certification.issuedAt)"),
      expiryDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD — expiry date; null/empty clears it"),
      credentialId: z.string().optional().describe("External credential id / license number"),
      courseId: z.string().optional().describe("Linked training course id (references TrainingCourse.id)"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:learning", user.isAdmin);
      const data = await mcpUpdateCertification(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_certification_delete",
    "Delete a certification record",
    { id: z.string().min(1).describe("Certification id (references Certification.id)") },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", "hr:learning", user.isAdmin);
      const data = await mcpDeleteCertification(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data ?? { success: true, id: String(id) }) }] };
    })
  );

  server.tool(
    "hr_learning_path_create",
    "Create a learning path",
    {
      name: z.string().min(1).describe("Learning path name (persisted to LearningPath.name, NOT NULL)"),
      description: z.string().optional(),
      targetRole: z.string().optional().describe("Target role/track the path prepares for"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:learning", user.isAdmin);
      const data = await mcpCreateLearningPath(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
