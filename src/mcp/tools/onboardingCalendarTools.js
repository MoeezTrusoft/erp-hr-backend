import { z } from "zod";
import { mcpCtx } from "../context.js";
import { withToolError } from "../utils/toolError.js";
import {
  checkSessionAvailability,
  scheduleOnboardingSession,
  finishOnboardingSession,
} from "../../services/onboardingCalendar.service.js";
export function registerOnboardingCalendarTools(server) {
  const id = z.number().int().positive(),
    version = z.number().int().nonnegative();
  const time = {
    sessionId: id,
    sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    fromTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z.string().min(1).max(100),
    durationMinutes: z.number().int().min(5).max(480),
    assigneeId: id,
  };
  for (const [name, description, schema, operation] of [
    [
      "hr_onboarding_session_availability",
      "Check HR leave, working time and interview/onboarding conflicts for the new hire and session owner",
      time,
      checkSessionAvailability,
    ],
    [
      "hr_onboarding_session_schedule",
      "Confirm one calendar invitation for a session after checking HR availability; rescheduling requires the displayed revision",
      {
        ...time,
        expectedVersion: version,
        confirmCalendar: z.literal(true),
        overrideReason: z.string().trim().max(1000).optional(),
      },
      scheduleOnboardingSession,
    ],
    [
      "hr_onboarding_session_finish",
      "Cancel with a reason or confirm an ended session complete with an attendance reference",
      {
        sessionId: id,
        expectedVersion: version,
        state: z.enum(["CANCELLED", "COMPLETED"]),
        reason: z.string().trim().min(1).max(1000),
      },
      finishOnboardingSession,
    ],
  ])
    server.tool(
      name,
      description,
      schema,
      withToolError(
        async (args) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await operation(args, mcpCtx.getStore()?.user?.tenantId),
              ),
            },
          ],
        }),
        name,
      ),
    );
}
