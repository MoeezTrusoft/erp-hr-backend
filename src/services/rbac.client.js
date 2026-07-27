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

const CANONICAL_PERMISSION = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;

const verifiedAmbientIdentity = () => {
  const store = mcpCtx.getStore();
  if (!store?.actorVerified || !store.user) return null;
  const user = store.user;
  // A verified service principal is still not a user. Emitting user metadata
  // without a signed user id recreates the F-01 service-only JWT/header seam.
  if (user.userId == null && user.employeeId == null) return null;
  const rawPermissions = Array.isArray(store.permissions)
    ? store.permissions
    : typeof store.permissions === "string"
      ? store.permissions.split(/[\s,]+/)
      : [];
  const permissions = [...new Set(rawPermissions.filter((permission) =>
    typeof permission === "string" && CANONICAL_PERMISSION.test(permission)
  ))];
  return {
    user: { ...user, roles: Array.isArray(user.roles) ? user.roles : [] },
    permissions,
  };
};

const signedActorClaims = () => {
  const identity = verifiedAmbientIdentity();
  if (!identity) return {};
  const { user, permissions } = identity;
  return {
    ...(user.userId != null ? { userId: String(user.userId) } : {}),
    ...(user.email ? { email: user.email } : {}),
    ...(user.employeeId != null ? { employeeId: String(user.employeeId) } : {}),
    roles: Array.isArray(user.roles) ? user.roles : [],
    scope: permissions.join(" "),
    permissions,
  };
};

const withInternalAuth = (headers = {}) => {
  const merged = { ...headers, ...ambientTenantHeader(), "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET };
  // F-01/F-02: sign the same verified actor represented by compatibility
  // headers. The tenant remains supplied by signServiceJwtEdDSA's ambient tid.
  const token = signServiceJwtEdDSA(signedActorClaims());
  if (token) merged["X-Service-Authorization"] = `Bearer ${token}`;
  return merged;
};

// Compatibility headers are rebuilt from the same verified ambient actor signed
// into the service JWT. Raw inbound/request-supplied identity is never forwarded.
const actorIdentityHeaders = () => {
  const identity = verifiedAmbientIdentity();
  if (!identity) return {};
  const { user, permissions } = identity;
  const headers = {};
  if (user.userId != null) headers["X-User-Id"] = String(user.userId);
  if (user.email) headers["X-User-Email"] = String(user.email);
  if (user.employeeId != null) headers["X-Employee-Id"] = String(user.employeeId);
  // Compatibility metadata mirrors the normalized claims signed above.
  headers["X-User-Permissions"] = JSON.stringify(permissions);
  if (user.roles !== undefined) headers["X-User-Roles"] = JSON.stringify(user.roles ?? []);
  // isAdmin is fail-closed to false in HR's verified context; forward verbatim.
  headers["X-Is-Admin"] = user.isAdmin ? "true" : "false";
  return headers;
};

const withoutIdentityHeaders = (headers = {}) => Object.fromEntries(
  Object.entries(headers).filter(([name]) => ![
    "x-user-id",
    "x-user-email",
    "x-employee-id",
    "x-user-roles",
    "x-user-permissions",
    "x-is-admin",
  ].includes(name.toLowerCase()))
);

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
 * @param {object} [actorHeaders] extra non-identity headers; attempted X-User-*
 *   overrides are discarded so headers cannot diverge from signed claims.
 * @returns {Promise<{ ok: true, user: object } | { ok: false, status?: number, error: string, code?: string }>}
 *   — a tool/authz error (403 forbidden, duplicate email/phone, invalid roleId)
 *   is RETURNED (never thrown) with its message; a network/transport error is
 *   also returned as { ok:false, error } (fail-soft).
 */
export async function createRbacSystemAccount(payload, actorHeaders = {}, options = {}) {
  const rpc = {
    jsonrpc: "2.0",
    id: options.idempotencyKey || `hr-syscacct-${Date.now()}`,
    method: "tools/call",
    params: { name: "rbac_employee_create", arguments: payload },
  };
  try {
    const res = await rbacApi.request({
      url: "/mcp",
      method: "POST",
      headers: withInternalAuth({
        ...withoutIdentityHeaders(actorHeaders),
        ...actorIdentityHeaders(),
        "Content-Type": "application/json",
        // MCP StreamableHTTP transport REQUIRES the SSE accept alongside JSON.
        Accept: "application/json, text/event-stream",
        // F-03: the RBAC consumer must reserve this stable key and reject a
        // mismatched fingerprint. Additive headers are safe before consumer rollout.
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        ...(options.payloadFingerprint
          ? { "X-Idempotency-Fingerprint": options.payloadFingerprint }
          : {}),
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

    // Success: content[0].text is the RBAC controller envelope
    // { success: true, employee: { id, ... } }. Unwrap to the created User.
    let user = null;
    if (text) {
      try {
        const parsed = JSON.parse(text);
        user = parsed?.employee || parsed?.user || parsed;
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

// ─── RBAC ORG READS (departments live in RBAC, scoped to the tenant's Company) ──
// These let HR read the authoritative org structure from RBAC over the internal
// service plane — via RBAC's MCP endpoint (/mcp), NOT its REST /api routes
// (those sit behind a USER `authenticate` middleware HR can't satisfy; /mcp sits
// behind internalServiceGuard + gatewayIdentity, which the service-JWT + the
// forwarded acting-user headers DO satisfy). Authorization still applies: RBAC's
// department tools assert the acting user's `/rbac/api/department` VIEW grant, so
// a user without it gets an empty result. Fail-soft: any error → empty result so
// an HR read never breaks when RBAC is degraded or the grant is absent.

// Low-level JSON-RPC call to a RBAC MCP method (tools/call or resources/read).
// Returns the parsed JSON-RPC `result`, or throws on transport/tool error.
async function rbacMcp(method, params) {
  const rpc = { jsonrpc: "2.0", id: `hr-${Date.now()}`, method, params };
  const res = await rbacApi.request({
    url: "/mcp",
    method: "POST",
    headers: withInternalAuth({
      ...actorIdentityHeaders(),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }),
    data: rpc,
    responseType: "text",
    transitional: { silentJSONParsing: false },
  });
  const rpcMsg = parseMcpBody(res?.data);
  if (rpcMsg?.error) throw new Error(rpcMsg.error.message || "RBAC MCP error");
  const result = rpcMsg?.result;
  // tools/call returns content[]; resources/read returns contents[]. Tool-level
  // errors come back as { isError:true, content:[{text: JSON({error,status})}] }.
  if (result?.isError) {
    let p = {};
    try { p = JSON.parse(result?.content?.[0]?.text ?? "{}"); } catch { /* leak-safe */ }
    throw new Error(p.error || "RBAC tool error");
  }
  const text = result?.content?.[0]?.text ?? result?.contents?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

/**
 * List the acting user's company's departments from RBAC (resource rbac://departments).
 * @returns {Promise<Array<{ id:number, name:string, description?:string|null }>>}
 */
export async function listDepartments() {
  try {
    const data = await rbacMcp("resources/read", { uri: "rbac://departments" });
    const arr = data?.departments ?? data?.data ?? (Array.isArray(data) ? data : []);
    return (Array.isArray(arr) ? arr : [])
      .map((d) => ({ id: d.id, name: d.name, description: d.description ?? null }))
      .filter((d) => d.id != null && d.name);
  } catch (err) {
    logger.warn({ err: err?.message }, "rbac.client: listDepartments failed — department will be null");
    return [];
  }
}

/**
 * List the acting company's RBAC roles (resource rbac://roles) for name→id
 * resolution during bulk employee import. Fail-soft to [] so import degrades to
 * "role not found" flags rather than throwing.
 * @returns {Promise<Array<{ id:number, name:string }>>}
 */
export async function listRoles() {
  try {
    const data = await rbacMcp("resources/read", { uri: "rbac://roles" });
    const arr = data?.roles ?? data?.data ?? data?.items ?? (Array.isArray(data) ? data : []);
    return (Array.isArray(arr) ? arr : [])
      .map((r) => ({ id: r.id, name: r.name ?? r.roleName }))
      .filter((r) => r.id != null && r.name);
  } catch (err) {
    logger.warn({ err: err?.message }, "rbac.client: listRoles failed — role will not resolve");
    return [];
  }
}

/**
 * Get one RBAC department by id (tool rbac_department_get, tenant-scoped by company).
 * @returns {Promise<{ id:number, name:string, description?:string|null }|null>}
 */
export async function getDepartmentById(id) {
  if (id == null) return null;
  try {
    const data = await rbacMcp("tools/call", { name: "rbac_department_get", arguments: { id: String(id) } });
    const d = data?.department ?? data?.data ?? data ?? null;
    if (!d || d.id == null) return null;
    return { id: d.id, name: d.name, description: d.description ?? null };
  } catch (err) {
    logger.warn({ err: err?.message, id }, "rbac.client: getDepartmentById failed — department will be null");
    return null;
  }
}
