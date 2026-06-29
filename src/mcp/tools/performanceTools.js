import { z } from "zod";
import {
  mcpAddPerformanceFeedback,
  mcpAdjustCalibrationRating,
  mcpApproveGoal,
  mcpCreateCalibration,
  mcpCreateDevelopmentPlan,
  mcpCreateGoal,
  mcpCreatePerformanceReview,
  mcpFinalizeCalibration,
  mcpListCalibrationSessions,
  mcpListGoals,
  mcpListPerformanceMetrics,
  mcpListPerformanceReviews,
  mcpRecordGoalProgress,
  mcpUpdateGoal,
  mcpUpdatePerformanceReview,
} from "../controllers/performanceMcpController.js";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { toListEnvelope } from "../utils/listEnvelope.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerPerformanceTools(server) {
  // ── RESOURCES ────────────────────────────────────────────────────────────

  server.resource(
    "hr_performance_reviews_list",
    "hr://performance/reviews",
    { description: "List all performance reviews" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListPerformanceReviews(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_goals_list",
    "hr://goals",
    { description: "List all employee goals" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListGoals(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_calibration_sessions_list",
    "hr://calibration",
    { description: "List all calibration sessions" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListCalibrationSessions(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  server.resource(
    "hr_performance_metrics_list",
    "hr://performance/metrics",
    { description: "List all performance metrics" },
    async (uri) => {
      const { user } = getCtx();
      const data = await mcpListPerformanceMetrics(user);
      return { contents: [{ uri: uri.href, text: JSON.stringify(data), mimeType: "application/json" }] };
    }
  );

  // ── LIST TOOLS (FE list-screen binding) ──────────────────────────────────
  // IC-1: the HR FE binds the Performance Reviews LIST screen to the
  // `hr_performance_reviews_list` TOOL (tools/call). A same-named RESOURCE exists
  // but callTool could not resolve it, so the screen fell back to mock data. This
  // TOOL wraps the existing reviews list service, tenant-scoped via ctx, and
  // returns the FE-expected paginated envelope. Gated on hr:performance:VIEW.
  server.tool(
    "hr_performance_reviews_list",
    "List performance reviews (paginated) for the HR performance screen",
    {
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:performance", user.isAdmin);
      const data = await mcpListPerformanceReviews(user);
      return { content: [{ type: "text", text: JSON.stringify(toListEnvelope(data, args)) }] };
    }, "hr_performance_reviews_list")
  );

  // ── GOAL TOOLS ───────────────────────────────────────────────────────────

  server.tool(
    "hr_goal_create",
    "Create a new employee goal",
    {
      employeeId: z.string().min(1),
      title: z.string().min(1),
      description: z.string().optional(),
      targetDate: z.string().describe("ISO 8601 date"),
      weight: z.number().min(0).max(100).optional(),
      kpis: z.array(z.string()).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/goals", user.isAdmin);
      const data = await mcpCreateGoal(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_goal_update",
    "Update an employee goal",
    {
      id: z.string().min(1),
      title: z.string().optional(),
      description: z.string().optional(),
      targetDate: z.string().optional(),
      status: z.string().optional(),
      weight: z.number().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/goals/${id}`, user.isAdmin);
      const data = await mcpUpdateGoal(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_goal_approve",
    "Approve or reject an employee goal",
    {
      id: z.string().min(1),
      status: z.enum(["APPROVED", "REJECTED"]),
      feedback: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/goals/approve/${id}`, user.isAdmin);
      const data = await mcpApproveGoal(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_goal_progress_record",
    "Record progress on a goal",
    {
      goalId: z.string().min(1),
      progress: z.number().min(0).max(100).describe("Progress percentage"),
      notes: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/goals/progress", user.isAdmin);
      const data = await mcpRecordGoalProgress(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── PERFORMANCE REVIEW TOOLS ─────────────────────────────────────────────

  server.tool(
    "hr_performance_review_create",
    "Create a performance review for an employee",
    {
      employeeId: z.string().min(1),
      reviewerId: z.string().min(1),
      cycleId: z.string().optional(),
      reviewType: z.string().optional().describe("e.g. ANNUAL, MID_YEAR, PROBATION"),
      dueDate: z.string().optional().describe("ISO 8601 date"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/performance", user.isAdmin);
      const data = await mcpCreatePerformanceReview(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_performance_review_update",
    "Update a performance review",
    {
      id: z.string().min(1),
      status: z.string().optional(),
      overallRating: z.number().optional(),
      comments: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/performance/${id}`, user.isAdmin);
      const data = await mcpUpdatePerformanceReview(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_performance_feedback_add",
    "Add feedback to a performance review",
    {
      reviewId: z.string().min(1),
      feedbackType: z.string().optional().describe("e.g. SELF, PEER, MANAGER"),
      content: z.string().min(1),
      rating: z.number().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/performance", user.isAdmin);
      const data = await mcpAddPerformanceFeedback(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── CALIBRATION TOOLS ────────────────────────────────────────────────────

  server.tool(
    "hr_calibration_create",
    "Create a calibration session",
    {
      title: z.string().min(1),
      cycleId: z.string().optional(),
      scheduledDate: z.string().optional().describe("ISO 8601 date"),
      participants: z.array(z.string()).optional().describe("Participant employee IDs"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/calibration", user.isAdmin);
      const data = await mcpCreateCalibration(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_calibration_update",
    "Update a calibration session",
    {
      id: z.string().min(1),
      status: z.string().optional(),
      notes: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/calibration/finalize/${id}`, user.isAdmin);
      const data = await mcpFinalizeCalibration(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_calibration_adjust_rating",
    "Submit a rating adjustment in a calibration session",
    {
      sessionId: z.string().min(1),
      employeeId: z.string().min(1),
      adjustedRating: z.number(),
      justification: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/calibration/adjust", user.isAdmin);
      const data = await mcpAdjustCalibrationRating(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_calibration_finalize",
    "Finalize a calibration session",
    { id: z.string().min(1) },
    withToolError(async ({ id }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", `/hr/api/calibration/finalize/${id}`, user.isAdmin);
      const data = await mcpFinalizeCalibration(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── DEVELOPMENT PLANS ────────────────────────────────────────────────────

  server.tool(
    "hr_development_plan_create",
    "Create an individual development plan (IDP) for an employee",
    {
      employeeId: z.string().min(1),
      title: z.string().min(1),
      startDate: z.string().optional().describe("ISO 8601 date"),
      endDate: z.string().optional().describe("ISO 8601 date"),
      objectives: z.string().optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "/hr/api/development-plans", user.isAdmin);
      const data = await mcpCreateDevelopmentPlan(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
