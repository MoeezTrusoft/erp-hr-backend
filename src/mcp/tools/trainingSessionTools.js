// src/mcp/tools/trainingSessionTools.js — Training session management MCP tools.
//
// List, create, update, mark attendance, upload recording.
// Gated on hr:learning and tenant-scoped.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  createSession,
  listSessions,
  updateSession,
  markAttendance,
  uploadRecording,
} from "../../services/trainingSession.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerTrainingSessionTools(server) {
  server.tool(
    "hr_training_session_list",
    "List training sessions for a course with pagination",
    {
      courseId: z.union([z.number(), z.string()]).describe("Course ID"),
      page: z.number().int().positive().optional().describe("Page number"),
      limit: z.number().int().positive().optional().describe("Rows per page"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:learning", user.isAdmin);
      const data = await listSessions({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_training_session_list")
  );

  server.tool(
    "hr_training_session_create",
    "Create a new training session for a course",
    {
      courseId: z.union([z.number(), z.string()]).describe("Course ID"),
      title: z.string().min(1).describe("Session title"),
      format: z.string().optional().describe("Session format (e.g. in-person, virtual)"),
      scheduledAt: z.string().describe("Scheduled date/time (ISO 8601)"),
      durationMinutes: z.number().int().positive().optional().describe("Duration in minutes"),
      facilitatorId: z.union([z.number(), z.string()]).optional().describe("Facilitator employee ID"),
      maxAttendees: z.number().int().positive().optional().describe("Max attendees"),
      location: z.string().optional().describe("Session location"),
      notes: z.string().optional().describe("Session notes"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:learning", user.isAdmin);
      const data = await createSession({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_training_session_create")
  );

  server.tool(
    "hr_training_session_update",
    "Update a training session",
    {
      id: z.union([z.number(), z.string()]).describe("Session ID"),
      title: z.string().optional().describe("Session title"),
      scheduledAt: z.string().optional().describe("Scheduled date/time"),
      durationMinutes: z.number().int().positive().optional().describe("Duration in minutes"),
      location: z.string().optional().describe("Session location"),
      notes: z.string().optional().describe("Session notes"),
    },
    withToolError(async ({ id, ...data }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:learning", user.isAdmin);
      const result = await updateSession(id, data, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }, "hr_training_session_update")
  );

  server.tool(
    "hr_training_session_attendance",
    "Mark attendance for a training session attendee",
    {
      sessionId: z.union([z.number(), z.string()]).describe("Session ID"),
      employeeId: z.union([z.number(), z.string()]).describe("Employee ID"),
      attended: z.boolean().describe("Whether the employee attended"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:learning", user.isAdmin);
      const data = await markAttendance({ ...args, tenantId: user.tenantId });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_training_session_attendance")
  );

  server.tool(
    "hr_training_session_recording_upload",
    "Upload a recording for a training session",
    {
      id: z.union([z.number(), z.string()]).describe("Session ID"),
      fileBase64: z.string().describe("Base64-encoded recording file"),
      fileName: z.string().optional().describe("File name"),
    },
    withToolError(async ({ id, fileBase64, fileName }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", "hr:learning", user.isAdmin);
      const buffer = Buffer.from(fileBase64, "base64");
      const file = { buffer, originalname: fileName || "recording.mp4", mimetype: "video/mp4" };
      const data = await uploadRecording(id, file, user.tenantId);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_training_session_recording_upload")
  );
}
