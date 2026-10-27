import {
  ACCEPTANCE_TOOLS,
  AcceptanceResult,
} from "@trusoft/contracts/attendance-acceptance";
import { acceptanceCommand } from "../../services/attendance-acceptance/service.js";
import { advertisedObjectSchema } from "./assessmentTools.js";
import { withToolError } from "../utils/toolError.js";
export function registerAttendanceAcceptanceTools(server) {
  for (const [name, d] of Object.entries(ACCEPTANCE_TOOLS))
    server.registerTool(
      name,
      {
        description: "Onsite attendance acceptance: " + d.route,
        inputSchema: advertisedObjectSchema(d.input).shape,
        outputSchema: AcceptanceResult.shape,
      },
      withToolError(async (input) => {
        const data = await acceptanceCommand(name, input);
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      }, name),
    );
}
