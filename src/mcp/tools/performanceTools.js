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
      employeeId: z.string().min(1).describe("Employee id the goal belongs to (references Employee.id)"),
      title: z.string().min(1),
      description: z.string().optional(),
      category: z.string().optional().describe("Free-text goal category label"),
      start_date: z.string().describe("ISO 8601 date YYYY-MM-DD — goal start (Goal.start_date, NOT NULL)"),
      end_date: z.string().describe("ISO 8601 date YYYY-MM-DD — goal target/end (Goal.end_date, NOT NULL)"),
      target_value: z.number().optional().describe("Numeric target for the goal metric"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const data = await mcpCreateGoal(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_goal_update",
    "Update an employee goal",
    {
      id: z.string().min(1).describe("Goal id to update (references Goal.id)"),
      title: z.string().optional(),
      description: z.string().optional(),
      progress: z.number().min(0).max(100).optional().describe("Progress percentage (0-100) — updates Goal.progress"),
      status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "APPROVED", "REJECTED"]).optional().describe("Goal status — one of PENDING | IN_PROGRESS | COMPLETED | APPROVED | REJECTED"),
      expectedVersion: z.number().int().optional().describe("optimistic-concurrency guard; the version you last read — a stale value returns -32009"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:performance", user.isAdmin);
      const data = await mcpUpdateGoal(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_goal_approve",
    "Approve or reject an employee goal",
    {
      id: z.string().min(1).describe("Goal id to approve or reject (references Goal.id)"),
      status: z.enum(["APPROVED", "REJECTED"]).describe("Decision — one of APPROVED | REJECTED"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:performance", user.isAdmin);
      const data = await mcpApproveGoal(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_goal_progress_record",
    "Record progress on a goal",
    {
      goalId: z.string().min(1).describe("Goal id to record progress against (references Goal.id)"),
      progress: z.number().min(0).max(100).describe("Progress percentage (0-100)"),
      comment: z.string().optional().describe("Progress note (persisted to GoalProgress.comment)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const data = await mcpRecordGoalProgress(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── PERFORMANCE REVIEW TOOLS ─────────────────────────────────────────────

  server.tool(
    "hr_performance_review_create",
    "Create a performance review for an employee",
    {
      employeeId: z.string().min(1).describe("Employee being reviewed (references Employee.id)"),
      reviewerId: z.string().min(1).describe("Reviewer employee id (references Employee.id)"),
      cycleId: z.string().optional().describe("Performance cycle id (references PerformanceCycle.id)"),
      period_start: z.string().describe("ISO 8601 date YYYY-MM-DD — review period start (required by service)"),
      period_end: z.string().describe("ISO 8601 date YYYY-MM-DD — review period end (required by service)"),
      reviewType: z.enum(["SELF", "MANAGER", "PEER", "HR"]).optional().describe("Maps to PerformanceReview.type — one of SELF | MANAGER | PEER | HR (default SELF)"),
      comments: z.string().optional().describe("Optional review comments"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const data = await mcpCreatePerformanceReview(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_performance_review_update",
    "Update a performance review",
    {
      id: z.string().min(1).describe("Performance review id (references PerformanceReview.id)"),
      status: z.enum(["IN_PROGRESS", "FINALIZED", "DRAFT"]).optional().describe("Review status — one of IN_PROGRESS | FINALIZED | DRAFT"),
      overallRating: z.number().optional().describe("Overall rating score (maps to PerformanceReview.overall_rating)"),
      comments: z.string().optional(),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:performance", user.isAdmin);
      const data = await mcpUpdatePerformanceReview(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_performance_feedback_add",
    "Add feedback to a performance review",
    {
      reviewId: z.string().min(1).describe("Performance review id the feedback attaches to (references PerformanceReview.id)"),
      reviewerId: z.string().min(1).describe("Employee id giving the feedback (references Employee.id)"),
      feedback: z.string().min(1).describe("Feedback text (persisted to ReviewFeedback.feedback, NOT NULL)"),
      rating: z.number().optional().describe("Optional feedback rating score"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const data = await mcpAddPerformanceFeedback(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── CALIBRATION TOOLS ────────────────────────────────────────────────────

  server.tool(
    "hr_calibration_create",
    "Create a calibration session",
    {
      name: z.string().min(1).describe("Calibration session name (persisted to CalibrationSession.name, NOT NULL)"),
      cycleId: z.string().min(1).describe("Performance cycle id (references PerformanceCycle.id; required by service)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const data = await mcpCreateCalibration(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_calibration_update",
    "Finalize a calibration session (marks it COMPLETED and finalizes its cycle's reviews)",
    {
      id: z.string().min(1).describe("Calibration session id to finalize (references CalibrationSession.id)"),
    },
    withToolError(async ({ id, ...rest }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:performance", user.isAdmin);
      const data = await mcpFinalizeCalibration(user, id, rest);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  server.tool(
    "hr_calibration_adjust_rating",
    "Submit a rating adjustment in a calibration session",
    {
      reviewId: z.string().min(1).describe("Performance review id being re-rated (references PerformanceReview.id)"),
      old_rating: z.number().describe("The review's rating before calibration (RatingAdjustment.old_rating, NOT NULL)"),
      new_rating: z.number().describe("The calibrated rating (RatingAdjustment.new_rating, NOT NULL)"),
      justification: z.string().optional().describe("Reason for the adjustment"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
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
      assertPermission(permissions, "PUT", "hr:performance", user.isAdmin);
      const data = await mcpFinalizeCalibration(user, id);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );

  // ── DEVELOPMENT PLANS ────────────────────────────────────────────────────

  server.tool(
    "hr_development_plan_create",
    "Create an individual development plan (IDP) for an employee",
    {
      employeeId: z.string().min(1).describe("Employee the plan is for (references Employee.id)"),
      title: z.string().min(1),
      description: z.string().optional().describe("Plan description / objectives (persisted to DevelopmentPlan.description)"),
      startDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD — defaults to now() when omitted"),
      endDate: z.string().optional().describe("ISO 8601 date YYYY-MM-DD — plan target end"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:performance", user.isAdmin);
      const data = await mcpCreateDevelopmentPlan(user, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    })
  );
}
