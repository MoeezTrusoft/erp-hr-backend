// src/mcp/utils/mcpErrorMap.js — ERR-5 · HR-nnnn → JSON-RPC error mapping.
//
// The MCP facade must surface the SAME machine-stable HR-nnnn code that REST
// returns, mapped to a JSON-RPC error per ARCH-05 Appendix B, keyed on the
// error CODE (not its message). Machine clients branch on error.data.code
// (the HR-nnnn) and on the numeric JSON-RPC code:
//   validation           HR-1000 → -32602 (invalid params)
//   forbidden            HR-4030 → -32003 (with permission in data when known)
//   not-found            HR-4040 → -32004
//   conflict             HR-4090 → -32001
//   precondition/stale   HR-4120 → -32009 (with currentVersion in data when known)
//   internal / unknown   HR-5000 → -32603 (generic; NO raw detail — ERR-3)
import { normalizeError } from '../../middlewares/error.middleware.js';

const CODE_TO_JSONRPC = {
    'HR-1000': -32602,
    'HR-1001': -32602,
    'HR-4010': -32001,
    'HR-4030': -32003,
    'HR-4040': -32004,
    'HR-4090': -32001,
    'HR-4120': -32009,
    'HR-4280': -32009,
    'HR-5000': -32603,
};

/**
 * Map any caught error to a JSON-RPC error object with a leak-safe message and
 * error.data.code carrying the HR-nnnn. 5xx never leaks the raw message (ERR-3).
 *
 * @param {unknown} err
 * @returns {{ code:number, message:string, data:object }}
 */
export function toJsonRpcError(err) {
    const norm = normalizeError(err);
    const jsonrpcCode = CODE_TO_JSONRPC[norm.code] ?? -32603;

    const data = { code: norm.code };
    if (norm.details !== undefined) data.details = norm.details;
    // Appendix B extras, surfaced from the error when the domain set them.
    if (err && err.currentVersion !== undefined) data.currentVersion = err.currentVersion;
    if (err && err.permission !== undefined) data.permission = err.permission;

    return { code: jsonrpcCode, message: norm.message, data };
}

export default toJsonRpcError;
