// src/services/rbac.client.js — internal RBAC lookups for HR.
//
// The consolidated employee profile sources Company name and Department name(s)
// from RBAC (they are NOT stored on the HR Employee row): the org identity is
// owned by RBAC, HR only holds a tenant uuid + businessUnit/gradeLevel.
//
// Auth mirrors dam.media.service.js: X-Internal-Secret + a signed service JWT
// (signServiceJwt) so the call is accepted on the internal plane. Fail-soft:
// any error returns nulls so the profile still renders without org names.
import axios from "axios";
import logger from "../lib/logger.js";
import { signServiceJwtEdDSA, ambientTenantHeader } from "../lib/serviceJwt.js";
import { mcpCtx } from "../mcp/context.js";

const RBAC_BASE_URL = process.env.RBAC_SERVICE_URL || "http://localhost:3001";
const RBAC_TIMEOUT = parseInt(process.env.RBAC_SERVICE_TIMEOUT || "10000", 10);

const rbacApi = axios.create({ baseURL: RBAC_BASE_URL, timeout: RBAC_TIMEOUT });

const withInternalAuth = (headers = {}) => {
  const merged = { ...headers, ...ambientTenantHeader(), "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET };
  const token = signServiceJwtEdDSA(); // RBAC verifies HR on the EdDSA plane (carries tid)
  if (token) merged["X-Service-Authorization"] = `Bearer ${token}`;
  return merged;
};

// Rebuild the acting user's gateway-identity headers from the ambient MCP/REST
// context (mcpCtx), so a HR→RBAC call carries the SAME principal HR was invoked
// for. RBAC authorizes POST /api/employee against this user (gatewayIdentity →
// assertPermission needs rbac:create); forwarding these is what lets RBAC see
// the REAL operator, not HR's service identity. The values mirror exactly what
// buildContextFromHeaders read off the inbound request (X-User-Id /
// X-User-Permissions / X-User-Roles / X-Is-Admin), so nothing is escalated here
// — a user lacking rbac:create still gets a 403 from RBAC.
const actorIdentityHeaders = () => {
  const store = mcpCtx.getStore();
  const user = store?.user;
  if (!user) return {};
  const headers = {};
  if (user.userId != null) headers["X-User-Id"] = String(user.userId);
  if (user.email) headers["X-User-Email"] = String(user.email);
  if (user.employeeId != null) headers["X-Employee-Id"] = String(user.employeeId);
  // Roles + permissions travel as JSON exactly as RBAC's gatewayIdentity parses
  // them (parseJsonHeader). permissions come from the top-level ctx.permissions
  // blob (the entitlement map the gateway forwarded), roles from user.roles.
  if (store.permissions !== undefined) headers["X-User-Permissions"] = JSON.stringify(store.permissions ?? {});
  if (user.roles !== undefined) headers["X-User-Roles"] = JSON.stringify(user.roles ?? []);
  // isAdmin is fail-closed to false in HR's verified context; forward verbatim.
  headers["X-Is-Admin"] = user.isAdmin ? "true" : "false";
  return headers;
};

// Parse a Streamable-HTTP MCP reply body into the JSON-RPC result object. The
// transport answers with either a plain JSON envelope (enableJsonResponse) OR a
// text/event-stream frame ("event: message\ndata: {…}\n\n"); tolerate both so a
// server-side transport tweak can't silently break provisioning. Returns the
// parsed JSON-RPC message ({ result | error }), or null when unparseable.
const parseMcpBody = (body) => {
  if (body && typeof body === "object") return body; // axios already JSON-parsed
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  // SSE frame: pull the last non-empty `data:` line and JSON-parse it.
  if (/^event:|^data:/m.test(trimmed)) {
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const last = dataLines[dataLines.length - 1];
    if (!last) return null;
    try {
      return JSON.parse(last);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

/**
 * Provision a login User in RBAC for a freshly-created HR employee.
 *
 * Calls the RBAC MCP tool `rbac_employee_create` at POST {rbac}/mcp (JSON-RPC
 * tools/call). This is the ALREADY-AUTHORIZED path the FE uses via the gateway:
 * /mcp is mounted behind RBAC's internalServiceGuard + gatewayIdentity, so HR's
 * EdDSA service JWT passes the boundary, the forwarded X-User-* identity headers
 * populate gatewayIdentity, and the tool runs
 * assertPermission(permissions, "POST", "/rbac/api/employee", isAdmin) against
 * the acting user (needs rbac:create). No user Bearer token is required — unlike
 * the REST route /api/employee (authenticate), which HR could not satisfy.
 *
 * @param {object} payload  the rbac_employee_create arguments: first_name,
 *   last_name, job_title, email, phone, gender, hire_date, status, roles,
 *   password, hrEmployeeId, mediaId.
 * @param {object} [actorHeaders]  extra headers to merge (rarely needed).
 * @returns {Promise<{ ok: true, user: object } | { ok: false, status?: number, error: string, code?: string }>}
 *   — a tool/authz error (403 forbidden, duplicate email/phone, invalid roleId)
 *   is RETURNED (never thrown) with its message; a network/transport error is
 *   also returned as { ok:false, error } (fail-soft).
 */
export async function createRbacSystemAccount(payload, actorHeaders = {}) {
  const rpc = {
    jsonrpc: "2.0",
    id: `hr-syscacct-${Date.now()}`,
    method: "tools/call",
    params: { name: "rbac_employee_create", arguments: payload },
  };
  try {
    const res = await rbacApi.request({
      url: "/mcp",
      method: "POST",
      headers: withInternalAuth({
        ...actorIdentityHeaders(),
        ...actorHeaders,
        "Content-Type": "application/json",
        // MCP StreamableHTTP transport REQUIRES the SSE accept alongside JSON.
        Accept: "application/json, text/event-stream",
      }),
      data: rpc,
      // The transport may answer as an SSE frame; take the raw text and parse
      // it ourselves (parseMcpBody handles JSON and SSE).
      responseType: "text",
      transitional: { silentJSONParsing: false },
    });

    const rpcMsg = parseMcpBody(res?.data);
    // JSON-RPC transport-level error (e.g. malformed request, method not found).
    if (rpcMsg?.error) {
      const e = rpcMsg.error;
      return { ok: false, status: null, error: e.message || "RBAC MCP error", code: e.data?.code ?? e.code };
    }

    const result = rpcMsg?.result;
    const text = result?.content?.[0]?.text;
    // Tool-level error: withToolError returns { isError:true, content:[{text:
    // JSON.stringify({error,status})}] } instead of throwing.
    if (result?.isError) {
      let parsed = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      const error = parsed.error || "RBAC system-account provisioning failed";
      logger.warn(
        { status: parsed.status ?? null, error, hrEmployeeId: payload?.hrEmployeeId },
        "rbac.client: rbac_employee_create tool error — employee kept, login provisioning did not"
      );
      return { ok: false, status: parsed.status ?? null, error, code: parsed.code };
    }

    // Success: content[0].text is the created user JSON ({ id, ... }).
    let user = null;
    if (text) {
      try {
        user = JSON.parse(text);
      } catch {
        user = null;
      }
    }
    return { ok: true, user };
  } catch (err) {
    // Transport/network failure (or a boundary 401/403 from internalServiceGuard
    // / gatewayIdentity before the tool ran). Fail-soft.
    const status = err?.response?.status ?? null;
    const parsedErr = parseMcpBody(err?.response?.data);
    const error =
      parsedErr?.error?.message ||
      parsedErr?.message ||
      err?.message ||
      "RBAC system-account provisioning failed";
    logger.warn(
      { status, error, hrEmployeeId: payload?.hrEmployeeId },
      "rbac.client: createRbacSystemAccount failed — employee kept, login provisioning did not"
    );
    return { ok: false, status, error, code: parsedErr?.error?.data?.code };
  }
}

/**
 * Resolve the RBAC user linked to an HR employee id.
 * GET {rbac}/api/auth/user/by-employee/:employeeId
 *
 * @returns {Promise<{companyName: string|null, companyId: (string|number)|null,
 *   departments: string[], raw: object|null}>}
 *   — fail-soft: nulls/empties on any error.
 */
export async function getUserByEmployeeId(employeeId) {
  const empty = { companyName: null, companyId: null, departments: [], raw: null };
  if (!employeeId) return empty;

  try {
    const res = await rbacApi.request({
      url: `/api/auth/user/by-employee/${encodeURIComponent(employeeId)}`,
      method: "GET",
      headers: withInternalAuth(),
    });
    // Tolerate common envelope shapes: {data:{...}} | {user:{...}} | {...}.
    const body = res?.data;
    const user = body?.data ?? body?.user ?? body ?? null;
    if (!user || typeof user !== "object") return empty;

    const company = user.role?.company ?? user.company ?? null;
    const departments = Array.isArray(user.departments)
      ? user.departments.map((d) => (typeof d === "string" ? d : d?.name)).filter(Boolean)
      : [];

    return {
      companyName: company?.name ?? null,
      companyId: company?.id ?? company?.uuid ?? null,
      departments,
      raw: user,
    };
  } catch (err) {
    logger.warn(
      { err: err?.message, employeeId, status: err?.response?.status },
      "rbac.client: getUserByEmployeeId failed — profile will render without org names"
    );
    return empty;
  }
}
