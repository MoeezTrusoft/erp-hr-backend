import crypto from "node:crypto";

import logger from "../../lib/logger.js";
import { toJsonRpcError } from "./mcpErrorMap.js";

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

/**
 * REQ-HR-004 — the resource twin of withToolError.
 *
 * MCP *tools* were wrapped; MCP *resources* were not, so an exception inside a
 * resource handler escaped as whatever the underlying layer threw. A Prisma
 * validation error therefore reached the browser as user-facing banner text,
 * complete with the query shape and column names — an ERR-3 leak as well as a
 * terrible error message.
 *
 * Same mapping as the tool wrapper (HR-nnnn in `code`, leak-safe message), in
 * the `contents` envelope a resource read must return.
 *
 * @param {Function} fn resource handler: (uri, ...rest) => ({ contents: [...] })
 * @param {string} resourceUri for logs
 */
export function withResourceError(fn, resourceUri = "unknown_resource") {
  return async (uri, ...rest) => {
    try {
      return await fn(uri, ...rest);
    } catch (err) {
      const jsonrpc = toJsonRpcError(err);
      logger.error({
        resource: resourceUri,
        err,
        code: jsonrpc.data.code,
        jsonrpcCode: jsonrpc.code,
      }, "MCP resource read failed");
      const body = {
        error: jsonrpc.message,
        status: err?.status || err?.httpStatus || err?.statusCode || 500,
        code: jsonrpc.data.code,
        jsonrpc: { code: jsonrpc.code, data: jsonrpc.data },
      };
      return {
        isError: true,
        contents: [{
          uri: uri?.href ?? String(resourceUri),
          mimeType: "application/json",
          text: JSON.stringify(body),
        }],
      };
    }
  };
}

export function withToolError(fn, toolName = "unknown_tool") {
  return async (args) => {
    try {
      // Debug-only, and even here we never log the raw args (redact globs are
      // one-level-deep and would miss nested sensitive shapes).
      logger.debug({ toolName, argsHash: hashArgs(args) }, "MCP tool start");
      return await fn(args);
    } catch (err) {
      // ERR-5: map the error to the SAME HR-nnnn the REST facade returns,
      // carried in error.data.code with a leak-safe message (ERR-3: 5xx never
      // emits the raw err.message / Prisma / RLS detail to the caller).
      const jsonrpc = toJsonRpcError(err);
      logger.error({
        toolName,
        argsHash: hashArgs(args),
        err,
        code: jsonrpc.data.code,
        jsonrpcCode: jsonrpc.code,
      }, "MCP tool failed");
      // `status` retained for back-compat with existing tool clients/tests that
      // key on the HTTP-ish status; `code` (HR-nnnn) + `jsonrpc` are the ERR-5
      // additions machine clients should branch on. `error` is leak-safe (ERR-3).
      const body = {
        error: jsonrpc.message,
        status: err?.status || err?.httpStatus || err?.statusCode || 500,
        code: jsonrpc.data.code,
        jsonrpc: { code: jsonrpc.code, data: jsonrpc.data },
      };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(body) }],
      };
    }
  };
}
