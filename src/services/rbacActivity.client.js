// src/services/rbacActivity.client.js — Activity-tab data from RBAC.
//
// Calls the RBAC activity-by-employee endpoint (added in Phase 4) which returns
// lastLogin, device/os, 2FA status, active sessions (30d), failed attempts and
// permissions/roles for the user linked to an HR employee. Auth mirrors
// rbac.client.js (service-JWT + internal secret). Fail-soft: any error (incl.
// the still-held JWT-alignment 401) returns { available:false } so the profile
// still renders and lights up automatically once RBAC trusts HR's issuer.
import axios from "axios";
import logger from "../lib/logger.js";
import { signServiceJwtEdDSA } from "../lib/serviceJwt.js";

const RBAC_BASE_URL = process.env.RBAC_SERVICE_URL || "http://localhost:3001";
const RBAC_TIMEOUT = parseInt(process.env.RBAC_SERVICE_TIMEOUT || "10000", 10);

const rbacApi = axios.create({ baseURL: RBAC_BASE_URL, timeout: RBAC_TIMEOUT });

const authHeaders = () => {
  const h = { "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET };
  const token = signServiceJwtEdDSA();
  if (token) h["X-Service-Authorization"] = `Bearer ${token}`;
  return h;
};

/**
 * @returns {Promise<object>} activity block, or { available:false, reason } on failure.
 */
export async function getEmployeeActivity(employeeId) {
  if (!employeeId) return { available: false, reason: "no employeeId" };
  try {
    const res = await rbacApi.get(
      `/api/auth/user/by-employee/${encodeURIComponent(employeeId)}/activity`,
      { headers: authHeaders() }
    );
    const body = res?.data;
    const data = body?.data ?? body ?? null;
    if (!data || typeof data !== "object") return { available: false, reason: "empty" };
    return { available: true, ...data };
  } catch (err) {
    logger.warn(
      { err: err?.message, employeeId, status: err?.response?.status },
      "rbacActivity.client: activity fetch failed (cross-service auth may be pending)"
    );
    return { available: false, reason: err?.response?.status === 401 || err?.response?.status === 403 ? "cross-service auth pending" : err?.message || "unavailable" };
  }
}
