// src/mcp/tools/internal-referral.tools.js
//
// Recruitment Phase 5 (plan 6.2) — employee referrals, the HR side.
//
// Who may do what (hr:recruitment, with the HTTP method):
//   * list referrals (GET): ORG sees every referral; a hiring manager
//     (MANAGED) sees the referrals on the requisitions they own; every other
//     scope gets an empty page. The bonus amount and currency only reach a
//     scope that may see compensation (ORG, FINANCE).
//   * decide a bonus (PUT): ORG only, with the version the caller read
//     (expectedVersion), so two people cannot decide the same bonus twice.
//
// Both answer 503 HR-RECRUITMENT-INTERNAL-BOARD-DISABLED while the
// internalBoard flag is off.
import { z } from "zod";

import { mcpCtx as mcpRequestContext } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { resolveRecruitmentScope } from "../../lib/recruitmentAccess.js";
import {
  BONUS_DECISION_TARGETS,
  BONUS_FORFEIT_REASONS,
  BONUS_STATUSES,
  FORFEIT_NOTE_MAX_LENGTH,
  REFERRAL_STATUSES,
} from "../../lib/internal-mobility.util.js";
import {
  assertInternalBoardEnabled,
  listReferrals,
  updateReferralBonus,
} from "../../services/internal-referral.service.js";

const RESOURCE = "hr:recruitment";

function getCtx() {
  const ctx = mcpRequestContext.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return { user: ctx.user, permissions: ctx.permissions || {} };
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const idInput = z.union([z.string(), z.number()]);

const actorOf = (user) => {
  const id = Number(user?.employeeId);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function registerInternalReferralTools(server) {
  server.tool(
    "hr_recruitment_referrals_list",
    `List employee referrals, newest first, with their status, hire date and bonus status, the referring employee (referrerEmployeeId and referrerName) and who decided the bonus (bonusDecidedById and bonusDecidedByName). Filters: status (${REFERRAL_STATUSES.join(" | ")}), bonusStatus (${BONUS_STATUSES.join(" | ")}), referrerEmployeeId, requisitionId. Hiring managers see the referrals on their own requisitions; the bonus amount is shown to recruiters and finance only.`,
    {
      status: z.enum(REFERRAL_STATUSES).optional().describe("Referral status"),
      bonusStatus: z.enum(BONUS_STATUSES).optional().describe("Bonus status"),
      referrerEmployeeId: idInput.optional().describe("The referring employee"),
      requisitionId: idInput.optional().describe("The requisition"),
      page: z.coerce.number().int().min(1).optional().describe("Page number (default 1)"),
      pageSize: z.coerce.number().int().min(1).max(100).optional().describe("Rows per page (default 50, max 100)"),
    },
    withToolError(async (args = {}) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "GET", RESOURCE, user.isAdmin);
      assertInternalBoardEnabled();
      const scope = resolveRecruitmentScope(user);
      return text(await listReferrals({ tenantId: user.tenantId, scope, ...args }));
    }, "hr_recruitment_referrals_list"),
  );

  server.tool(
    "hr_recruitment_referral_bonus_update",
    `Decide a referral bonus (recruiters only). APPROVED (from ELIGIBLE) needs amount and currency; PAID is from APPROVED; FORFEITED (from ELIGIBLE or APPROVED) needs a reason (${BONUS_FORFEIT_REASONS.join(" | ")}; OTHER needs a note). Pass the version you read as expectedVersion; a stale version is refused (409).`,
    {
      referralId: idInput.describe("Referral id"),
      expectedVersion: z.coerce.number().int().min(0).describe("The referral version you read"),
      bonusStatus: z.enum(BONUS_DECISION_TARGETS).describe("The decision"),
      amount: z.union([z.string(), z.number()]).optional().describe("Bonus amount (APPROVED), up to two decimals"),
      currency: z.string().length(3).optional().describe("ISO currency code (APPROVED), e.g. PKR"),
      reason: z.enum(BONUS_FORFEIT_REASONS).optional().describe("Why the bonus is forfeited (FORFEITED)"),
      note: z.string().max(FORFEIT_NOTE_MAX_LENGTH).optional().describe("Free text; required with reason OTHER"),
    },
    withToolError(async ({ referralId, expectedVersion, bonusStatus, amount, currency, reason, note }) => {
      const { user, permissions } = getCtx();
      assertPermission(permissions, "PUT", RESOURCE, user.isAdmin);
      assertInternalBoardEnabled();
      const scope = resolveRecruitmentScope(user);
      if (scope.unrestricted !== true) {
        throw Object.assign(new Error("Only recruiters may decide referral bonuses"), {
          status: 403,
          code: "HR-RECRUITMENT-REFERRAL-FORBIDDEN",
        });
      }
      const data = await updateReferralBonus({
        tenantId: user.tenantId,
        referralId,
        expectedVersion,
        bonusStatus,
        amount: amount == null ? undefined : String(amount),
        currency,
        reason,
        note,
        actorId: actorOf(user),
      });
      return text(data);
    }, "hr_recruitment_referral_bonus_update"),
  );
}
