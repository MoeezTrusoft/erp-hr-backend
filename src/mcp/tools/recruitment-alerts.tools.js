// src/mcp/tools/recruitment-alerts.tools.js
//
// Recruitment Phase 5 (plan 6.10) — analytics threshold alerts.
//
// Every tool here is behind the analyticsAlerts flag (off: 503, HR-5031) and
// limited to the ORG recruitment scope (HR admin / HR manager / recruiter):
// the alerts describe the whole tenant's funnel, so a hiring manager or an
// interviewer, who sees only part of it, gets 403 rather than tenant-wide
// figures. Changing thresholds and acknowledging are PUT; reading is GET.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import { ALERT_METRICS, ALERT_STATUSES } from "../../lib/recruitment-alerts.util.js";
import {
  acknowledgeRecruitmentAlert,
  assertAlertsEnabled,
  getAlertThresholds,
  listRecruitmentAlerts,
  setAlertThresholds,
} from "../../services/recruitment-alerts.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const forbidden = () =>
  Object.assign(new Error("Only recruiters can use recruitment analytics alerts"), {
    status: 403,
    code: "HR-RECRUITMENT-ALERTS-FORBIDDEN",
  });

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

/** Permission, flag and ORG scope, in that order; returns the caller. */
function authorize(method) {
  const { user, permissions } = getCtx();
  assertPermission(permissions, method, RESOURCE, user.isAdmin);
  assertAlertsEnabled();
  const scope = resolveRecruitmentScope(user);
  if (scope.unrestricted !== true) throw forbidden();
  return { user, scope };
}

const thresholdValue = (label) => z.number().nullable().optional().describe(`${label}; null stops watching it`);

export function registerRecruitmentAlertTools(server) {
  server.tool(
    "hr_recruitment_alert_thresholds_get",
    "Read the tenant's recruitment analytics alert thresholds (time to fill days, SLA breaches, offer decline rate %, failed handoffs), the alert recipient and the settings version to pass when changing them. Metrics are measured over a rolling 30-day window.",
    {},
    withToolError(async () => {
      const { user } = authorize("GET");
      return text(await getAlertThresholds({ tenantId: user.tenantId }));
    }, "hr_recruitment_alert_thresholds_get"),
  );

  server.tool(
    "hr_recruitment_alert_thresholds_set",
    "Change the recruitment analytics alert thresholds and/or the employee who receives the alerts (recruiters only). Pass the settings version you read as expectedVersion; a stale version is refused. A threshold you leave out is unchanged; null stops watching that metric. An alert opens when a metric goes above its threshold.",
    {
      expectedVersion: z.coerce.number().int().min(0).describe("The settings version you read (0 when never saved)"),
      thresholds: z
        .object({
          timeToFillDays: thresholdValue("Mean time to fill in days (1-365)"),
          slaBreaches: thresholdValue("Open applications past their stage SLA (whole number, 0 = any)"),
          offerDeclineRatePct: thresholdValue("Share of offers declined, percent (0-100)"),
          failedHandoffs: thresholdValue("Hire handoffs left failed (whole number, 0 = any)"),
        })
        .strict()
        .optional()
        .describe("The thresholds to change"),
      alertRecipientId: z.coerce.number().int().positive().nullable().optional()
        .describe("Employee id who receives the alerts; null falls back to the recruiting lead"),
    },
    withToolError(async (args) => {
      const { user, scope } = authorize("PUT");
      const saved = await setAlertThresholds({
        tenantId: user.tenantId,
        actorId: scope.employeeId ?? null,
        expectedVersion: args.expectedVersion,
        thresholds: args.thresholds,
        alertRecipientId: args.alertRecipientId,
      });
      return text(saved);
    }, "hr_recruitment_alert_thresholds_set"),
  );

  server.tool(
    "hr_recruitment_alerts_list",
    "List the tenant's recruitment analytics alerts, most recently seen first, optionally by status (OPEN, ACKNOWLEDGED, RESOLVED) and metric (TIME_TO_FILL, SLA_BREACHES, OFFER_DECLINE_RATE, FAILED_HANDOFFS).",
    {
      status: z.enum(ALERT_STATUSES).optional().describe("Only alerts in this status"),
      metric: z.enum(ALERT_METRICS).optional().describe("Only alerts on this metric"),
      limit: z.coerce.number().int().min(1).max(200).optional().describe("Max alerts to return (default 50)"),
    },
    withToolError(async (args) => {
      const { user } = authorize("GET");
      return text(await listRecruitmentAlerts({ tenantId: user.tenantId, status: args.status, metric: args.metric, limit: args.limit }));
    }, "hr_recruitment_alerts_list"),
  );

  server.tool(
    "hr_recruitment_alert_acknowledge",
    "Acknowledge an open recruitment analytics alert (recruiters only). It stays acknowledged while the metric is still above its threshold and resolves on its own once it is back under.",
    {
      alertId: z.coerce.number().int().positive().describe("The alert id"),
    },
    withToolError(async (args) => {
      const { user, scope } = authorize("PUT");
      const alert = await acknowledgeRecruitmentAlert({
        tenantId: user.tenantId,
        alertId: args.alertId,
        actorId: scope.employeeId ?? null,
      });
      return text(alert);
    }, "hr_recruitment_alert_acknowledge"),
  );
}
