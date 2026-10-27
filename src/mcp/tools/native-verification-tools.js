import { z } from "zod";
import { mcpCtx } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { nativeHrDenied } from "../../services/native-verification-guard.service.js";
import {
  NativeEntryStatusInput,
  NativeEntryStatusOutput,
  nativeVerificationEntryStatus,
} from "../../services/native-verification-status.service.js";

export function registerNativeVerificationTools(
  server,
  { statusReader = nativeVerificationEntryStatus } = {},
) {
  // Explicit CREATE authorization: this narrowly scoped observation must neither
  // grant nor require employee VIEW based on the tool's "status" suffix.
  server.registerTool(
    "hr_native_verification_entry_status",
    {
      description: "Read one owned native-verification provisioning entry without advancing it",
      inputSchema: NativeEntryStatusInput,
      outputSchema: z.object({ success: z.literal(true), data: NativeEntryStatusOutput }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withToolError(async (input) => {
      const ctx = mcpCtx.getStore() ?? {};
      try {
        assertPermission(ctx.permissions, "POST", "hr:employee", false);
      } catch {
        nativeHrDenied();
      }
      const parsed = NativeEntryStatusOutput.safeParse(await statusReader(input, { ctx }));
      if (!parsed.success) nativeHrDenied();
      const data = parsed.data;
      const result = { success: true, data };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }, "hr_native_verification_entry_status"),
  );
}
