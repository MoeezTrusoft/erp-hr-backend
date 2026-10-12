// src/mcp/tools/attendanceImportTools.js
//
// Attendance history BULK IMPORT (HR-ATT-IMPORT-01) — two tools:
//   hr_attendance_import_template → download the empty .xlsx template
//   hr_attendance_import          → upload a filled .csv/.xlsx; validate,
//                                   auto-fix, annotate, and (optionally) commit.
//
// Mirrors the employee importer's contract deliberately: same base64 delivery,
// same dryRun-by-default preview, same annotated-result file. An operator who
// has already loaded employees knows how to drive this without new docs.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission, hasPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  generateAttendanceImportTemplate,
  runAttendanceImport,
} from "../../services/attendanceImport.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user)
    throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function registerAttendanceImportTools(server) {
  server.tool(
    "hr_attendance_import_template",
    "Download the empty attendance bulk-import spreadsheet (.xlsx). One row per employee per day, with dropdowns for day_type / status / work_mode / leave_type / anomaly_type / anomaly_resolution, plus Example and Instructions tabs. Returns the file as base64. Fill the 'Attendance' tab and upload it to hr_attendance_import.",
    z.object({}),
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      const data = await generateAttendanceImportTemplate();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_import_template"),
  );

  server.tool(
    "hr_attendance_import",
    "Preview historical attendance or commit the reviewed batch in resumable chunks. Never silently approves anomalies or overwrites protected corrections.",
    {
      fileBase64: z.string().max(16000000).optional(),
      format: z.enum(["xlsx", "csv"]).optional(),
      dryRun: z.boolean().optional(),
      importLeaves: z.boolean().optional(),
      importAnomalies: z.boolean().optional(),
      replaceCorrected: z.boolean().optional(),
      approvalReference: z.string().max(1000).optional(),
      batchId: z.string().uuid().optional(),
      previewToken: z.string().optional(),
      reason: z.string().max(2000).optional(),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      if (args.replaceCorrected)
        assertPermission(permissions, "PUT", "hr:attendance", user.isAdmin);
      const data = await runAttendanceImport({
        ...args,
        mayReplaceCorrected:
          user.isAdmin || hasPermission(permissions, "hr:attendance", "EDIT"),
        tenantId: user.tenantId,
        actorId: user.id || user.userId || user.employeeId,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_import"),
  );
}
