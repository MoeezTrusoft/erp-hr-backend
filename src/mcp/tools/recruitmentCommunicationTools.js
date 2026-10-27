import {
  communicationFailuresList,
  communicationEventRetry,
} from "../../services/candidateCommunicationRecovery.service.js";
import { z } from "zod";
import { RecruitmentPolicy } from "@trusoft/contracts/recruitment-policy";
import { withToolError } from "../utils/toolError.js";
import {
  recruitmentSettingsGet,
  recruitmentSettingsSet,
} from "../../services/recruitmentSettings.service.js";
import {
  candidateCommunicationsList,
  candidateCommunicationRetry,
  candidateCommunicationCancel,
} from "../../services/candidateCommunication.service.js";
export function registerRecruitmentCommunicationTools(server) {
  const mutation = {
    id: z.string().uuid(),
    reason: z.string().trim().min(10).max(2000),
  };
  const definitions = [
    [
      "hr_recruitment_communication_failures_list",
      "Inspect failed candidate communication events without payloads; HR administrators only",
      {
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().min(1).max(100).default(25),
      },
      communicationFailuresList,
    ],
    [
      "hr_recruitment_communication_event_retry",
      "Requeue a failed communication event after review; preserves fan-out cursor and message deduplication",
      { ...mutation, expectedAttempts: z.number().int().nonnegative() },
      communicationEventRetry,
    ],
    [
      "hr_tenant_recruitment_settings_get",
      "Read recruitment policy and current version",
      {},
      recruitmentSettingsGet,
    ],
    [
      "hr_tenant_recruitment_settings_set",
      "Record an HR administrator-approved recruitment policy version",
      {
        policy: RecruitmentPolicy,
        reconcileJobBoards: z.boolean().default(false),
        expectedVersion: z.number().int().nonnegative(),
        reason: z.string().trim().min(10).max(2000),
      },
      recruitmentSettingsSet,
    ],
    [
      "hr_candidate_communications_list",
      "Read delivery metadata without private mailbox links",
      {
        candidateId: z.coerce.number().int().positive(),
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().min(1).max(100).default(25),
      },
      candidateCommunicationsList,
    ],
    [
      "hr_candidate_communication_retry",
      "Retry a failed message using the original idempotency key",
      mutation,
      candidateCommunicationRetry,
    ],
    [
      "hr_candidate_communication_cancel",
      "Cancel a pending message before provider acceptance",
      mutation,
      candidateCommunicationCancel,
    ],
  ];
  for (const [name, description, shape, handler] of definitions)
    server.tool(
      name,
      description,
      shape,
      withToolError(
        async (args) => ({
          content: [{ type: "text", text: JSON.stringify(await handler(args)) }],
        }),
        name,
      ),
    );
}
