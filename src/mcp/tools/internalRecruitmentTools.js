import {
  InternalJobQuery,
  InternalJobInput,
  InternalApplyInput,
  InternalReferInput,
  ReferralListInput,
  ReferralReviewInput,
} from "@trusoft/contracts/recruitment-sourcing";
import {
  listInternalJobs,
  getInternalJob,
  applyInternally,
  referContact,
  listInternalReferrals,
  reviewReferralBonus,
} from "../../services/internalRecruitment.service.js";
import { withToolError } from "../utils/toolError.js";
export function registerInternalRecruitmentTools(server) {
  const tools = [
    [
      "hr_internal_jobs_list",
      "List open employee jobs or referral opportunities in your company.",
      InternalJobQuery,
      listInternalJobs,
    ],
    [
      "hr_internal_job_get",
      "Read the published details of an employee or referral opportunity.",
      InternalJobInput,
      getInternalJob,
    ],
    [
      "hr_internal_apply",
      "Email your private application form to your HR-recorded mailbox; candidate consent is collected on that form.",
      InternalApplyInput,
      applyInternally,
    ],
    [
      "hr_employee_referral_create",
      "Refer a contact who has agreed to be contacted; the candidate must provide their own processing consent and application.",
      InternalReferInput,
      referContact,
    ],
    [
      "hr_employee_referrals_list",
      "List your own referral receipts, or the authorized recruiter bonus-review queue.",
      ReferralListInput,
      listInternalReferrals,
    ],
    [
      "hr_employee_referral_review",
      "Independently record referral bonus eligibility after the candidate submits their application.",
      ReferralReviewInput,
      reviewReferralBonus,
    ],
  ];
  for (const [name, description, inputSchema, handler] of tools) {
    server.registerTool(
      name,
      { description, inputSchema },
      withToolError(
        async (args) => ({
          content: [
            { type: "text", text: JSON.stringify(await handler(args)) },
          ],
        }),
        name,
      ),
    );
  }
}
