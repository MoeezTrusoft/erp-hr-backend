// src/mcp/tools/catalogTools.js
//
// Course Catalog (LMS) MCP facade. Exposes the browse/detail/playback/enroll/
// review reads + the section/lecture/outcome authoring writes for the FE course
// catalog. All tools gate on the "hr:learning" resource key (GET=view,
// POST=create, PUT=edit, DELETE=delete). Business logic lives in
// courseCatalog.service.js; these thin wrappers only do auth + arg threading.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  listCourseCatalog,
  getCourseDetail,
  getLecture,
  enrollInCourse,
  createReview,
  createSection,
  updateSection,
  deleteSection,
  createLecture,
  updateLecture,
  deleteLecture,
  createOutcome,
  deleteOutcome,
  updateCourseCatalogFields,
} from "../../services/courseCatalog.service.js";

// getCtx: read the verified request store. Throws 401 if unauthenticated. We
// also surface user.employeeId (present on the ctx user when the caller is an
// employee) so enroll/review can default the actor to "me".
function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

const RESOURCE = "hr:learning";

export function registerCatalogTools(server) {
  // ── BROWSE ────────────────────────────────────────────────────────────────
  server.tool(
    "hr_course_catalog_list",
    "Browse the course catalog: paginated course cards + a category-sidebar count map. Supports search, category/mode/tag filters, and sort. Course Type mapping (mode): ONLINE=Online, OFFLINE=On Site, HYBRID=Hybrid.",
    {
      q: z
        .string()
        .optional()
        .describe("Free-text search across course title, courseCode and subtitle (contains, case-insensitive)."),
      categoryId: z.coerce
        .number()
        .int()
        .optional()
        .describe("Filter to a single TrainingCategory.id. Does NOT affect the categoryCounts sidebar (which spans all categories under the current search)."),
      mode: z
        .enum(["ONLINE", "OFFLINE", "HYBRID"])
        .optional()
        .describe("Course Type filter. Allowed: ONLINE (Online), OFFLINE (On Site), HYBRID (Hybrid)."),
      tag: z
        .string()
        .optional()
        .describe("Filter to courses whose tags array contains this exact tag."),
      sort: z
        .enum(["newest", "oldest", "title_asc", "title_desc", "rating", "popular"])
        .optional()
        .describe("Sort order. Allowed: newest (createdAt desc, DEFAULT), oldest, title_asc, title_desc, rating (ratingAvg desc), popular (ratingCount desc)."),
      page: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based page number (default 1)."),
      pageSize: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Rows per page (default 20, max 100)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await listCourseCatalog({
        tenantId: user.tenantId,
        q: args.q,
        categoryId: args.categoryId,
        mode: args.mode,
        tag: args.tag,
        sort: args.sort,
        page: args.page,
        pageSize: args.pageSize,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_catalog_list")
  );

  // ── DETAIL ────────────────────────────────────────────────────────────────
  server.tool(
    "hr_course_get",
    "Full course-view detail: metadata, intro video (DAM), outcomes, related topics, requirements, and sections with their lectures. 404 if the course is not in the caller's tenant.",
    {
      id: z.coerce
        .number()
        .int()
        .describe("TrainingCourse.id to fetch."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getCourseDetail({ tenantId: user.tenantId, id: args.id });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_get")
  );

  // ── LECTURE (video playback) ───────────────────────────────────────────────
  server.tool(
    "hr_course_lecture_get",
    "Get a single course lecture with its DAM video stream metadata. Returns { streamPath, video } for the player (streamPath = DAM /assets/video-stream/<videoMediaId>). 404 if missing.",
    {
      id: z.coerce
        .number()
        .int()
        .describe("CourseLecture.id to fetch."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getLecture({ tenantId: user.tenantId, id: args.id });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_lecture_get")
  );

  // ── ENROLL ────────────────────────────────────────────────────────────────
  server.tool(
    "hr_course_enroll",
    "Enroll an employee in a course (idempotent: returns the existing enrollment if already enrolled). If employeeId is omitted, the caller's own employeeId (ctx) is used.",
    {
      courseId: z.coerce
        .number()
        .int()
        .describe("TrainingCourse.id to enroll into (required)."),
      employeeId: z.coerce
        .number()
        .int()
        .optional()
        .describe("Employee.id to enroll. If omitted, resolves to the caller's own employeeId from context; error 400 if neither is present."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const employeeId = args.employeeId ?? user.employeeId;
      if (employeeId == null) {
        throw Object.assign(new Error("employeeId required"), { status: 400 });
      }
      const data = await enrollInCourse({
        tenantId: user.tenantId,
        courseId: args.courseId,
        employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_enroll")
  );

  // ── REVIEW ────────────────────────────────────────────────────────────────
  server.tool(
    "hr_course_review_create",
    "Add a review (1-5 star rating + optional comment) to a course and recompute the course's denormalized ratingAvg/ratingCount. If employeeId is omitted, the caller's own employeeId (ctx) is used.",
    {
      courseId: z.coerce
        .number()
        .int()
        .describe("TrainingCourse.id being reviewed (required)."),
      rating: z.coerce
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Star rating, integer 1-5 (required)."),
      comment: z
        .string()
        .optional()
        .describe("Optional free-text review comment."),
      employeeId: z.coerce
        .number()
        .int()
        .optional()
        .describe("Reviewer Employee.id. If omitted, defaults to the caller's own employeeId from context (may be null for anonymous)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const employeeId = args.employeeId ?? user.employeeId ?? null;
      const data = await createReview({
        tenantId: user.tenantId,
        courseId: args.courseId,
        employeeId,
        rating: args.rating,
        comment: args.comment,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_review_create")
  );

  // ── COURSE LMS-FIELD PATCH ─────────────────────────────────────────────────
  server.tool(
    "hr_course_catalog_update",
    "Patch a course's LMS/catalog fields. Only the fields you pass are updated. Course Type (mode): ONLINE=Online, OFFLINE=On Site, HYBRID=Hybrid.",
    {
      id: z.coerce
        .number()
        .int()
        .describe("TrainingCourse.id to update (required)."),
      title: z.string().optional().describe("Course title."),
      subtitle: z.string().optional().describe("Short subtitle / tagline shown under the title."),
      courseCode: z.string().optional().describe("Human-facing course code (e.g. HR-101)."),
      description: z.string().optional().describe("Long-form course description."),
      categoryId: z.coerce
        .number()
        .int()
        .optional()
        .describe("TrainingCategory.id this course belongs to."),
      mode: z
        .enum(["ONLINE", "OFFLINE", "HYBRID"])
        .optional()
        .describe("Course Type. Allowed: ONLINE (Online), OFFLINE (On Site), HYBRID (Hybrid)."),
      language: z.string().optional().describe("Primary language of instruction (e.g. English)."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Free-text tags for search/filtering (replaces the whole array)."),
      relatedTopics: z
        .array(z.string())
        .optional()
        .describe("Related topic labels shown on the course-view page (replaces the whole array)."),
      requirements: z
        .array(z.string())
        .optional()
        .describe("Prerequisites/requirements bullet list (replaces the whole array)."),
      introVideoMediaId: z.coerce
        .number()
        .int()
        .optional()
        .describe("DAM asset id of the course intro/preview video."),
      createdById: z.coerce
        .number()
        .int()
        .optional()
        .describe("Employee.id of the course author/creator."),
      status: z
        .enum(["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"])
        .optional()
        .describe("Course status. Allowed: DRAFT, ACTIVE, COMPLETED, CANCELLED."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await updateCourseCatalogFields({ tenantId: user.tenantId, ...args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_catalog_update")
  );

  // ── SECTION AUTHORING ───────────────────────────────────────────────────────
  server.tool(
    "hr_course_section_create",
    "Create a curriculum section (chapter) under a course.",
    {
      courseId: z.coerce
        .number()
        .int()
        .describe("TrainingCourse.id the section belongs to (required)."),
      title: z.string().describe("Section title (required)."),
      sortOrder: z.coerce
        .number()
        .int()
        .optional()
        .describe("Display order among the course's sections (ascending; default 0)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await createSection({
        tenantId: user.tenantId,
        courseId: args.courseId,
        title: args.title,
        sortOrder: args.sortOrder,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_section_create")
  );

  server.tool(
    "hr_course_section_update",
    "Update a curriculum section's title and/or sort order. Only the fields you pass are changed.",
    {
      id: z.coerce
        .number()
        .int()
        .describe("CourseSection.id to update (required)."),
      title: z.string().optional().describe("New section title."),
      sortOrder: z.coerce
        .number()
        .int()
        .optional()
        .describe("New display order among the course's sections (ascending)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await updateSection({
        tenantId: user.tenantId,
        id: args.id,
        title: args.title,
        sortOrder: args.sortOrder,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_section_update")
  );

  server.tool(
    "hr_course_section_delete",
    "Delete a curriculum section (and its lectures via cascade).",
    {
      id: z.coerce
        .number()
        .int()
        .describe("CourseSection.id to delete (required)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", RESOURCE, user.isAdmin);
      const data = await deleteSection({ tenantId: user.tenantId, id: args.id });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_section_delete")
  );

  // ── LECTURE AUTHORING ───────────────────────────────────────────────────────
  server.tool(
    "hr_course_lecture_create",
    "Create a lecture under a section, optionally linked to a DAM video asset.",
    {
      sectionId: z.coerce
        .number()
        .int()
        .describe("CourseSection.id the lecture belongs to (required)."),
      title: z.string().describe("Lecture title (required)."),
      videoMediaId: z.coerce
        .number()
        .int()
        .optional()
        .describe("DAM asset id of the lecture video."),
      durationSeconds: z.coerce
        .number()
        .int()
        .optional()
        .describe("Video/lecture duration in seconds (default 0)."),
      sortOrder: z.coerce
        .number()
        .int()
        .optional()
        .describe("Display order among the section's lectures (ascending; default 0)."),
      isPreview: z
        .boolean()
        .optional()
        .describe("If true, this lecture is playable as a free preview before enrollment (default false)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await createLecture({
        tenantId: user.tenantId,
        sectionId: args.sectionId,
        title: args.title,
        videoMediaId: args.videoMediaId,
        durationSeconds: args.durationSeconds,
        sortOrder: args.sortOrder,
        isPreview: args.isPreview,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_lecture_create")
  );

  server.tool(
    "hr_course_lecture_update",
    "Update a lecture's fields. Only the fields you pass are changed.",
    {
      id: z.coerce
        .number()
        .int()
        .describe("CourseLecture.id to update (required)."),
      title: z.string().optional().describe("New lecture title."),
      videoMediaId: z.coerce
        .number()
        .int()
        .optional()
        .describe("DAM asset id of the lecture video."),
      durationSeconds: z.coerce
        .number()
        .int()
        .optional()
        .describe("Video/lecture duration in seconds."),
      sortOrder: z.coerce
        .number()
        .int()
        .optional()
        .describe("Display order among the section's lectures (ascending)."),
      isPreview: z
        .boolean()
        .optional()
        .describe("If true, playable as a free preview before enrollment."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const data = await updateLecture({
        tenantId: user.tenantId,
        id: args.id,
        title: args.title,
        videoMediaId: args.videoMediaId,
        durationSeconds: args.durationSeconds,
        sortOrder: args.sortOrder,
        isPreview: args.isPreview,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_lecture_update")
  );

  server.tool(
    "hr_course_lecture_delete",
    "Delete a lecture.",
    {
      id: z.coerce
        .number()
        .int()
        .describe("CourseLecture.id to delete (required)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", RESOURCE, user.isAdmin);
      const data = await deleteLecture({ tenantId: user.tenantId, id: args.id });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_lecture_delete")
  );

  // ── OUTCOME AUTHORING ───────────────────────────────────────────────────────
  server.tool(
    "hr_course_outcome_create",
    "Add a learning outcome (what the learner will achieve) to a course.",
    {
      courseId: z.coerce
        .number()
        .int()
        .describe("TrainingCourse.id the outcome belongs to (required)."),
      title: z.string().describe("Outcome title (required)."),
      description: z.string().optional().describe("Optional longer description of the outcome."),
      sortOrder: z.coerce
        .number()
        .int()
        .optional()
        .describe("Display order among the course's outcomes (ascending; default 0)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", RESOURCE, user.isAdmin);
      const data = await createOutcome({
        tenantId: user.tenantId,
        courseId: args.courseId,
        title: args.title,
        description: args.description,
        sortOrder: args.sortOrder,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_outcome_create")
  );

  server.tool(
    "hr_course_outcome_delete",
    "Delete a course learning outcome.",
    {
      id: z.coerce
        .number()
        .int()
        .describe("CourseOutcome.id to delete (required)."),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "DELETE", RESOURCE, user.isAdmin);
      const data = await deleteOutcome({ tenantId: user.tenantId, id: args.id });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_course_outcome_delete")
  );
}
