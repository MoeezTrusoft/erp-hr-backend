// src/mcp/tools/recruitment-settings.tools.js
//
// Phase 2 — the tenant's recruitment settings (delays, shortlist thresholds,
// default channels, the job feed switch and employer facts) and the source
// attribution report.
//
// Who may do what:
//   * read the settings: any recruitment scope with a requisition view (ORG and
//     MANAGED, and ASSIGNED interviewers). The feed token and the feed URLs are
//     the feed's only credential, so they go to ORG callers only.
//   * change the settings: ORG only, with the version the caller read
//     (expectedVersion), so two recruiters cannot overwrite each other.
//   * the source report: any recruitment scope, cut to the applications the
//     caller can see (applicationScopeWhere), so it is empty for FINANCE/AGENCY.
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import { isRecruitmentFlagEnabled } from "../../lib/recruitmentFlags.js";
import {
  getRecruitmentSettings,
  updateRecruitmentSettings,
} from "../../services/recruitment-settings.service.js";
import { buildJobFeedUrls } from "../../services/job-feed.service.js";
import { getRecruitmentSourceReport } from "../../services/recruitment-source.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx?.permissions || {} };
}

const forbidden = (message) =>
  Object.assign(new Error(message), { status: 403, code: "HR-RECRUITMENT-SETTINGS-FORBIDDEN" });

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

// The feed block an ORG caller sees: whether the platform flag and the tenant
// switch are on, and the URL to register with each board.
function withFeed(settings) {
  const { feedToken, ...rest } = settings;
  const feed = buildJobFeedUrls(feedToken);
  return {
    ...rest,
    feedToken: feedToken ?? null,
    feed: {
      flagEnabled: isRecruitmentFlagEnabled("jobFeed"),
      enabled: settings.feedEnabled === true,
      paths: feed?.paths ?? null,
      urls: feed?.urls ?? null,
    },
  };
}

// The fields hr_recruitment_settings_set may change. Ranges, https-only URLs
// and the channel rule are enforced by the service (one place for REST too).
const SETTINGS_FIELDS = Object.freeze([
  "defaultChannels",
  "rejectionDelayHours",
  "knockoutDelayHours",
  "shortlistThreshold",
  "shortlistTopPercent",
  "feedEnabled",
  "companyName",
  "companyUrl",
  "companyLogoUrl",
  "portalBaseUrl",
]);

const pickSettingsInput = (args) =>
  Object.fromEntries(SETTINGS_FIELDS.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));

const nullableUrl = (label) => z.string().max(500).nullable().optional().describe(`${label} (absolute https URL; null clears it)`);

export function registerRecruitmentSettingsTools(server) {
  server.tool(
    "hr_recruitment_settings_get",
    "Read the tenant's recruitment settings: default publication channels, knockout and rejection delays, shortlist thresholds, job feed switch and employer details. Recruiters also get the job feed URLs.",
    {},
    withToolError(async () => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const scope = resolveRecruitmentScope(user);
      if (!scope.canSeeRequisitions) throw forbidden("Not permitted to read recruitment settings");
      const settings = await getRecruitmentSettings({
        tenantId: user.tenantId,
        includeFeedToken: scope.unrestricted === true,
      });
      return text(scope.unrestricted === true ? withFeed(settings) : settings);
    }, "hr_recruitment_settings_get"),
  );

  server.tool(
    "hr_recruitment_settings_set",
    "Change the tenant's recruitment settings (recruiters only). Pass the version you read as expectedVersion; a stale version is refused. rotateFeedToken issues a new feed URL and stops the old one.",
    {
      expectedVersion: z.coerce.number().int().min(0).describe("The settings version you read (0 when never saved)"),
      rotateFeedToken: z.boolean().optional().describe("Issue a new job feed token; the old feed URL stops working"),
      defaultChannels: z.array(z.string()).optional().describe("Channels auto-publish uses; only channels that need no external URL (CAREER_SITE)"),
      rejectionDelayHours: z.coerce.number().int().optional().describe("Hours a rejection notice waits before it is sent (0-720)"),
      knockoutDelayHours: z.coerce.number().int().optional().describe("Hours a knockout rejection waits, reversible until then (0-720)"),
      shortlistThreshold: z.coerce.number().int().optional().describe("Fit score proposed for the shortlist (0-100)"),
      shortlistTopPercent: z.coerce.number().int().optional().describe("Top share of a requisition's ranking proposed for the shortlist (0-100)"),
      feedEnabled: z.boolean().optional().describe("Serve the XML job feed for this tenant"),
      companyName: z.string().max(200).nullable().optional().describe("Employer name shown in the job feed"),
      companyUrl: nullableUrl("Employer website"),
      companyLogoUrl: nullableUrl("Employer logo"),
      portalBaseUrl: nullableUrl("Careers portal base URL the feed's apply links point at"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      const scope = resolveRecruitmentScope(user);
      if (scope.unrestricted !== true) throw forbidden("Only recruiters can change recruitment settings");
      const saved = await updateRecruitmentSettings({
        tenantId: user.tenantId,
        actorId: scope.employeeId,
        expectedVersion: args.expectedVersion,
        rotateFeedToken: args.rotateFeedToken === true,
        input: pickSettingsInput(args),
      });
      return text(withFeed(saved));
    }, "hr_recruitment_settings_set"),
  );

  server.tool(
    "hr_recruitment_source_report",
    "Applications and hires per source channel (career site, LinkedIn, Indeed, referral, agency, ...; UNKNOWN when not recorded), optionally for one requisition and an applied-date range, limited to the applications you can see",
    {
      requisitionId: z.union([z.string(), z.number()]).optional().describe("Only this requisition's applications"),
      from: z.string().optional().describe("Applied on or after (ISO date or date-time)"),
      to: z.string().optional().describe("Applied on or before (ISO date or date-time)"),
    },
    withToolError(async (args) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      const data = await getRecruitmentSourceReport({
        tenantId: user.tenantId,
        scope: resolveRecruitmentScope(user),
        requisitionId: args.requisitionId,
        from: args.from,
        to: args.to,
      });
      return text(data);
    }, "hr_recruitment_source_report"),
  );
}
