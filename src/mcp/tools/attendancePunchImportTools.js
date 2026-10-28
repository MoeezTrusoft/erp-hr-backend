// Historical punch-log import (preview, commit) and period coverage.
import { z } from "zod";
import { mcpCtx } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import {
  commitPunchImport,
  periodCoverage,
  previewPunchImport,
} from "../../services/attendancePunchImport.service.js";
import { emitAttendanceCaptureChanged } from "../../services/hrConfigEvents.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fileText = z.string().max(8000000);

export function registerAttendancePunchImportTools(server) {
  const ctx = () => {
    const c = mcpCtx.getStore();
    if (!c?.user?.tenantId)
      throw Object.assign(new Error("Authentication required"), { status: 401 });
    return c;
  };
  const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

  server.tool(
    "hr_attendance_punch_import_preview",
    "Preview a historical punch log (CSV/TSV: device user ID, timestamp, optional status) for one device: counts, invalid rows, held punches and unmatched IDs. Saves nothing.",
    { sn: z.string().min(1).max(64), text: fileText },
    withToolError(async (args) => {
      const { user, permissions } = ctx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      return reply(await previewPunchImport({ ...args, tenantId: user.tenantId }));
    }, "hr_attendance_punch_import_preview"),
  );

  server.tool(
    "hr_attendance_punch_import",
    "Import the previewed punch log through the normal capture pipeline. Evaluation then uses the setup version and roster in force on each day. Safe to resend.",
    { sn: z.string().min(1).max(64), text: fileText, previewToken: z.string().length(64), reason: z.string().trim().min(1).max(1000) },
    withToolError(async (args) => {
      const { user, permissions } = ctx();
      assertPermission(permissions, "POST", "hr:attendance", user.isAdmin);
      const data = await commitPunchImport({
        ...args,
        tenantId: user.tenantId,
        actorId: user.id || user.userId || user.employeeId,
      });
      await emitAttendanceCaptureChanged({
        tenantId: user.tenantId,
        actorId: user.id || user.userId || user.employeeId,
        action: "punch_import_committed",
      });
      return reply(data);
    }, "hr_attendance_punch_import"),
  );

  server.tool(
    "hr_attendance_period_coverage",
    "For a date range: which attendance setup version judges each stretch, days with no setup, and employees whose roster does not cover the period",
    { from: date, to: date, employeeIds: z.array(z.number().int().positive()).max(1000).optional() },
    withToolError(async (args) => {
      const { user, permissions } = ctx();
      assertPermission(permissions, "GET", "hr:attendance", user.isAdmin);
      return reply(await periodCoverage({ ...args, tenantId: user.tenantId }));
    }, "hr_attendance_period_coverage"),
  );
}
