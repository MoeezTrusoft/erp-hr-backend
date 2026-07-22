import crypto from "node:crypto";

import logger from "../../lib/logger.js";

// LOG-4: HR MCP tools accept flat top-level C4-sensitive fields (iban, ntn,
// baseSalary, accountNumber, ...). The pino `*.<field>` redact globs only reach
// one level deep, so logging the raw `args` object wholesale can leak nested
// sensitive shapes on failure. Instead of the full payload we log a stable
// non-reversible fingerprint (argsHash) — enough to correlate a report with a
// specific call without emitting any PII/secret.
function hashArgs(args) {
  try {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(args ?? null))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return null;
  }
}

export function withToolError(fn, toolName = "unknown_tool") {
  return async (args) => {
    try {
      // Debug-only, and even here we never log the raw args (redact globs are
      // one-level-deep and would miss nested sensitive shapes).
      logger.debug({ toolName, argsHash: hashArgs(args) }, "MCP tool start");
      return await fn(args);
    } catch (err) {
      logger.error({
        toolName,
        argsHash: hashArgs(args),
        err,
        status: err?.status || 500,
      }, "MCP tool failed");
      const body = { error: err.message, status: err.status || 500 };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(body) }],
      };
    }
  };
}
