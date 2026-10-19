// src/services/engagement/pm-mcp.client.js — service-to-service call of the
// PM module's MCP tools (project_project_create / project_project_update),
// modelled on rbac.client.js (EdDSA service JWT + X-Internal-Secret, SSE or
// JSON reply). Fail-soft: returns { ok:false, error } instead of throwing so
// the project link records the failure and can be retried.
//
// Env: PM_SERVICE_URL (default http://localhost:3003), PM_MCP_PATH (default /mcp),
//      PM_SERVICE_TIMEOUT (ms).
import axios from "axios";

import logger from "../../lib/logger.js";
import { ambientTenantHeader, signServiceJwtEdDSA } from "../../lib/serviceJwt.js";

const PM_BASE_URL = process.env.PM_SERVICE_URL || "http://localhost:3003";
const PM_MCP_PATH = process.env.PM_MCP_PATH || "/mcp";
const PM_TIMEOUT = Number.parseInt(process.env.PM_SERVICE_TIMEOUT || "15000", 10);

let transport = null;
/** Test seam: inject a function (rpc) => responseBody. */
export const setPmTransport = (fn) => { transport = fn; };

const parseMcpBody = (body) => {
  if (body && typeof body === "object") return body;
  const text = String(body ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const frames = text.split("\n").filter((line) => line.startsWith("data:"));
    const last = frames[frames.length - 1];
    if (!last) return null;
    try {
      return JSON.parse(last.slice(5).trim());
    } catch {
      return null;
    }
  }
};

async function send(rpc, idempotencyKey) {
  if (transport) return transport(rpc);
  const headers = {
    ...ambientTenantHeader(),
    "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "x-mcp-internal": "1",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
  const token = signServiceJwtEdDSA();
  if (token) headers["X-Service-Authorization"] = `Bearer ${token}`;
  const res = await axios.request({
    baseURL: PM_BASE_URL,
    url: PM_MCP_PATH,
    method: "POST",
    timeout: PM_TIMEOUT,
    headers,
    data: rpc,
    responseType: "text",
    transitional: { silentJSONParsing: false },
  });
  return res?.data;
}

export async function callPmTool(name, args, { idempotencyKey } = {}) {
  const rpc = { jsonrpc: "2.0", id: idempotencyKey || `hr-engagement-${Date.now()}`, method: "tools/call", params: { name, arguments: args } };
  try {
    const body = parseMcpBody(await send(rpc, idempotencyKey));
    if (body?.error) return { ok: false, error: body.error.message || "PM MCP error", code: body.error.data?.code ?? body.error.code };
    const result = body?.result;
    const text = result?.content?.[0]?.text;
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : result?.structuredContent ?? null;
    } catch {
      parsed = null;
    }
    if (result?.isError) return { ok: false, error: parsed?.error || `PM tool ${name} failed`, code: parsed?.code, status: parsed?.status };
    return { ok: true, data: parsed?.data ?? parsed };
  } catch (err) {
    logger.warn({ tool: name, status: err?.response?.status ?? null, err: { message: err?.message } }, "pm-mcp.client: call failed");
    return { ok: false, error: err?.message || "PM unavailable", status: err?.response?.status ?? null };
  }
}
