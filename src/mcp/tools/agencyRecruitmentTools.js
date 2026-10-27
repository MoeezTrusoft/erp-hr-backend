import {
  AgencyProfileQuery,
  AgencyPageInput,
  AgencyJobInput,
  AgencyProfileInput,
  AgencyAssignmentInput,
  AgencyAssignmentListInput,
  AgencySubmitInput,
  AgencySubmissionsInput,
  AgencyReviewInput,
} from "@trusoft/contracts/recruitment-agency";
import {
  getAgencyProfile,
  saveAgencyProfile,
  listAgencyAccounts,
  listAgencyAssignments,
  setAgencyAssignment,
  listAgencyJobs,
  getAgencyJob,
  createAgencySubmission,
  listAgencySubmissions,
  reviewAgencySubmission,
} from "../../services/agencyRecruitment.service.js";
import { withToolError } from "../utils/toolError.js";
export function registerAgencyRecruitmentTools(server) {
  const tools = [
    [
      "hr_agency_profile_get",
      "Read your own agency profile without creating a record.",
      AgencyProfileQuery,
      getAgencyProfile,
    ],
    [
      "hr_agency_profile_upsert",
      "Register your verified agency account's business name; another user's identity cannot be supplied.",
      AgencyProfileInput,
      saveAgencyProfile,
    ],
    [
      "hr_agency_accounts_list",
      "Recruiter directory of registered agency accounts in this company.",
      AgencyPageInput,
      listAgencyAccounts,
    ],
    [
      "hr_agency_assignments_list",
      "Recruiter view of agency access assigned to one requisition.",
      AgencyAssignmentListInput,
      listAgencyAssignments,
    ],
    [
      "hr_agency_assignment_set",
      "Grant or revoke one agency's access to an approved requisition, with version checking.",
      AgencyAssignmentInput,
      setAgencyAssignment,
    ],
    [
      "hr_agency_jobs_list",
      "Read only published requisitions currently assigned to your agency account.",
      AgencyPageInput,
      listAgencyJobs,
    ],
    [
      "hr_agency_job_get",
      "Read the published job description and application questions for an assigned requisition.",
      AgencyJobInput,
      getAgencyJob,
    ],
    [
      "hr_agency_submission_create",
      "Invite an agreed contact to submit their own application and consent; preserve the first agency owner and return a neutral receipt.",
      AgencySubmitInput,
      createAgencySubmission,
    ],
    [
      "hr_agency_submissions_list",
      "Read your agency's submission receipts or the authorized recruiter review queue, without assessment notes or export.",
      AgencySubmissionsInput,
      listAgencySubmissions,
    ],
    [
      "hr_agency_submission_review",
      "Recruiter acceptance or rejection after candidate-owned application submission.",
      AgencyReviewInput,
      reviewAgencySubmission,
    ],
  ];
  for (const [name, description, inputSchema, handler] of tools)
    server.registerTool(
      name,
      { description, inputSchema },
      withToolError(
        async (args) => ({
          content: [{ type: "text", text: JSON.stringify(await handler(args)) }],
        }),
        name,
      ),
    );
}
