import { APPRAISAL_TOOLS } from "@trusoft/contracts/performance-appraisals";
import { handlers } from "../../services/appraisals/index.js";
export function registerAppraisalTools(server) {
  for (const [name, [, schema]] of Object.entries(APPRAISAL_TOOLS)) {
    server.registerTool(
      name,
      {
        description: name
          .replace("hr_appraisal_", "Appraisal ")
          .replaceAll("_", " "),
        inputSchema: schema,
      },
      async (raw) => {
        try {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(await handlers[name](schema.parse(raw))),
              },
            ],
          };
        } catch (error) {
          const validation = error.name === "ZodError";
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  code: validation
                    ? "VALIDATION_FAILED"
                    : error.status
                      ? error.code || "REQUEST_FAILED"
                      : "INTERNAL_ERROR",
                  message: validation
                    ? "Check the supplied fields"
                    : error.status
                      ? error.message
                      : "Unable to complete the request",
                  ...(validation
                    ? {
                        fields: error.issues.map((i) => ({
                          path: i.path.join("."),
                          message: i.message,
                        })),
                      }
                    : {}),
                  ...(error.details ? { details: error.details } : {}),
                }),
              },
            ],
          };
        }
      },
    );
  }
}
