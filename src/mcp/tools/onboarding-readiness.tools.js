// src/mcp/tools/onboarding-readiness.tools.js — Recruitment Phase 4 day-one
// readiness and onboarding survey tools (HR side).
//
//   hr_onboarding_readiness_get          one checklist: the live gap
//                                        computation next to the stored verdict
//   hr_onboarding_readiness_list         upcoming starts with their verdicts
//   hr_onboarding_survey_completion_get  30/60/90 completion per start-date
//                                        cohort month
//
// Auth: GET on hr:onboarding (HTTP method, never an action name), tenant from
// the verified context only. Behind the onboardingAutomation flag: off, each
// tool answers 503 HR-ONBOARDING-AUTOMATION-DISABLED (HR-5031).
import { z } from "zod";
import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { getOnboardingReadiness, listOnboardingReadiness } from "../../services/onboarding-readiness.service.js";
import { getOnboardingSurveyCompletion } from "../../services/onboarding-survey.service.js";

function getCtx() {
    const ctx = mcpRequestContext.getStore();
    if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
    return ctx;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const DATE_HINT = "YYYY-MM-DD or YYYY-MM (start-date cohort bound)";

export function registerOnboardingReadinessTools(server) {
    server.tool(
        "hr_onboarding_readiness_get",
        "Day-one readiness for one onboarding checklist: the live gaps (open pre-joining/pre-boarding tasks, unfulfilled IT provisioning requests, unsigned documents, uploads pending review, required sessions without a date) with counts by kind, next to the verdict the daily check stored (READY | AT_RISK, checkedAt, alertedAt).",
        {
            checklistId: z.coerce.number().int().positive().describe("Onboarding checklist id (references OnboardingChecklist)"),
        },
        withToolError(async ({ checklistId }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
            return ok(await getOnboardingReadiness({ tenantId: user.tenantId, checklistId }));
        }),
    );

    server.tool(
        "hr_onboarding_readiness_list",
        "Upcoming starts (open checklists starting from today through `days` ahead; default the tenant's readiness lead days) with their stored readiness verdicts, soonest first.",
        {
            days: z.coerce.number().int().min(0).max(60).optional().describe("Days ahead to include (0-60); defaults to the tenant's onboardingReadinessLeadDays"),
            status: z.enum(["READY", "AT_RISK", "UNCHECKED"]).optional().describe("Only checklists with this stored verdict (UNCHECKED = not yet checked)"),
            limit: z.coerce.number().int().min(1).max(200).optional().describe("Max rows (1-200); defaults to 50"),
        },
        withToolError(async ({ days, status, limit }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
            return ok(await listOnboardingReadiness({ tenantId: user.tenantId, days, status, limit }));
        }),
    );

    server.tool(
        "hr_onboarding_survey_completion_get",
        "30/60/90 day onboarding survey completion per survey type per start-date cohort month: counts issued / submitted / overdue / pending and the completion rate (percent, one decimal), plus totals per type. from/to bound the start date; the default is the last twelve months.",
        {
            from: z.string().optional().describe(DATE_HINT),
            to: z.string().optional().describe(DATE_HINT),
        },
        withToolError(async ({ from, to }) => {
            const { user, permissions } = getCtx();
            assertPermission(permissions, "GET", "hr:onboarding", user.isAdmin);
            return ok(await getOnboardingSurveyCompletion({ tenantId: user.tenantId, from, to }));
        }),
    );
}

export default registerOnboardingReadinessTools;
