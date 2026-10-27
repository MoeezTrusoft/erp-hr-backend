import { z } from "zod";
import { mcpCtx } from "../context.js";
import { assertPermission } from "../utils/assertPermission.js";
import { withToolError } from "../utils/toolError.js";
import { nativeHrDenied } from "../../services/native-verification-guard.service.js";
import {
  NativeEntryLifecycleInput,
  NativeEntryLifecycleOutput,
  nativeVerificationEntryLifecycle,
} from "../../services/native-verification-lifecycle.service.js";

export function registerNativeLifecycleTools(
  server,
  { lifecycleReader = nativeVerificationEntryLifecycle } = {},
) {
  // Explicit CREATE authorization: this narrowly scoped observation must neither
  // grant nor require employee VIEW based on the tool's "status" suffix.
  server.registerTool(
    "hr_native_verification_entry_lifecycle",
    {
      description:
        "Observe the persisted hired lifecycle event of one owned native entry without dispatching it",
      inputSchema: NativeEntryLifecycleInput,
      outputSchema: z
        .object({ success: z.literal(true), data: NativeEntryLifecycleOutput })
        .strict(),
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
      const parsed = NativeEntryLifecycleOutput.safeParse(await lifecycleReader(input, { ctx }));
      if (!parsed.success) nativeHrDenied();
      const data = parsed.data;
      const result = { success: true, data };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }, "hr_native_verification_entry_lifecycle"),
  );
}
