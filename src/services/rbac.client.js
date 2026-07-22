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

/**
 * Provision a login User in RBAC for a freshly-created HR employee.
 * POST {rbac}/api/employee — creates User (bcrypt password, roleId,
 * User.employeeId link, permission overrides). Authorized by RBAC against the
 * ACTING USER (forwarded via actorIdentityHeaders), NOT HR's service identity.
 *
 * @param {object} payload  RBAC POST /api/employee body (see employee.service.create).
 * @param {object} [actorHeaders]  extra headers to merge (rarely needed).
 * @returns {Promise<{ ok: true, user: object } | { ok: false, status?: number, error: string, code?: string }>}
 *   — a 4xx from RBAC (403 forbidden, duplicate email/phone, invalid roleId) is
 *   RETURNED (never thrown) with its message so the caller can surface it; a
 *   network/transport error is also returned as { ok:false, error } (fail-soft).
 */
export async function createRbacSystemAccount(payload, actorHeaders = {}) {
  try {
    const res = await rbacApi.request({
      url: "/api/employee",
      method: "POST",
      headers: withInternalAuth({ ...actorIdentityHeaders(), ...actorHeaders }),
      data: payload,
    });
    const body = res?.data;
    const user = body?.employee ?? body?.user ?? body?.data ?? body ?? null;
    return { ok: true, user };
  } catch (err) {
    const status = err?.response?.status ?? null;
    const body = err?.response?.data;
    const error = body?.message || body?.error || err?.message || "RBAC system-account provisioning failed";
    logger.warn(
      { status, error, hrEmployeeId: payload?.hrEmployeeId },
      "rbac.client: createRbacSystemAccount failed — employee kept, login provisioning did not"
    );
    return { ok: false, status, error, code: body?.code };
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
