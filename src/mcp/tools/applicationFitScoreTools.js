import { reverseAutomaticKnockout } from "../../services/applicationAutoDisposition.service.js";
import { z } from "zod";
import { withToolError } from "../utils/toolError.js";
import * as service from "../../services/applicationFitScore.service.js";
export function registerApplicationFitScoreTools(server) {
  const id = z.coerce.number().int().positive();
  const entries = [
    [
      "hr_application_automatic_rejection_reverse",
      "Reverse a policy-driven knockout rejection before its notice deadline",
      {
        applicationId: id,
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(10).max(2000),
      },
      reverseAutomaticKnockout,
    ],
    [
      "hr_application_score_get",
      "Read versioned advisory fit evidence",
      { applicationId: id },
      service.applicationScoreGet,
    ],
    [
      "hr_application_score_refresh",
      "Calculate and persist deterministic job-related fit evidence",
      { applicationId: id },
      service.applicationScoreRefresh,
    ],
    [
      "hr_requisition_rank_list",
      "Rank active applications using their latest advisory fit evidence",
      {
        requisitionId: id,
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().min(1).max(100).default(25),
      },
      service.requisitionRankList,
    ],
    [
      "hr_requisition_shortlist_propose",
      "Propose the top decile above a threshold for human review; does not shortlist or reject",
      {
        requisitionId: id,
        minimumScore: z.number().min(0).max(100).optional(),
      },
      service.requisitionShortlistPropose,
    ],
  ];
  for (const [name, description, schema, handler] of entries)
    server.tool(
      name,
      description,
      schema,
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
