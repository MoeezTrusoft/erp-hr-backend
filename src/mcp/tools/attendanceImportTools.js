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
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  generateAttendanceImportTemplate,
  runAttendanceImport,
} from "../../services/attendanceImport.service.js";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
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
    }, "hr_attendance_import_template")
  );

  server.tool(
    "hr_attendance_import",
    "Bulk-import historical attendance from an uploaded .csv/.xlsx (base64) — one row per employee per day. Validates and AUTO-FIXES every row (enum synonyms like WFH→Remote, day-first and ISO dates, 12/24-hour times, derived status, overnight shifts); anything unfixable is FLAGGED on a returned annotated .xlsx (colour-coded __row_status + plain-English __issues). PREVIEW by default (dryRun=true, nothing saved) — set dryRun=false to commit OK/auto-fixed rows. Rows UPSERT on employee+date, so re-running a file or resending a chunk corrects instead of duplicating. Consecutive same-type leave days collapse into one leave request; anomalies import already-decided so they never flood the HR review queue. Send at most ~5000 rows per call; chunks are independent.",
    {
      fileBase64: z
        .string()
        .min(1)
        .describe("The spreadsheet as base64. Use the template from hr_attendance_import_template."),
      format: z
        .enum(["xlsx", "csv"])
        .optional()
        .describe("Uploaded file format. Defaults to xlsx."),
      dryRun: z
        .boolean()
        .optional()
        .describe("TRUE (default) validates and returns the annotated report without saving anything. Set false to commit."),
      importLeaves: z
        .boolean()
        .optional()
        .describe("Also create Leave records from day_type=LEAVE rows, merging consecutive same-type days. Default true."),
      importAnomalies: z
        .boolean()
        .optional()
        .describe("Also create AttendanceAnomaly records from anomaly_type rows, already decided. Default true."),
    },
    withToolError(async ({ fileBase64, format, dryRun, importLeaves, importAnomalies }) => {
      const { user, permissions } = getCtx();
      // Writing six years of history is a CREATE on attendance, not a read — and
      // the dryRun preview is gated the same way, because its validation
      // messages enumerate the tenant's employee codes.
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await runAttendanceImport({
        tenantId: user.tenantId,
        fileBase64: String(fileBase64).replace(/^data:[^,]+,/, ""),
        format: format ?? "xlsx",
        dryRun: dryRun ?? true,
        importLeaves: importLeaves ?? true,
        importAnomalies: importAnomalies ?? true,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }, "hr_attendance_import")
  );
}
