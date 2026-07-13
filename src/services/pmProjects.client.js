// src/services/pmProjects.client.js — Overview-tab Projects from PM.
//
// Calls the PM projects-by-employee endpoint (added in Phase 5). PM keys project
// membership off the RBAC userId (employeeUserId), so callers pass the userId
// resolved via rbac.client (by-employee → user.id). Auth mirrors rbac.client.js.
// Fail-soft: any error returns { available:false, items:[] }.
import axios from "axios";
import logger from "../lib/logger.js";
import { signServiceJwtEdDSA } from "../lib/serviceJwt.js";

const PM_BASE_URL = process.env.PM_SERVICE_URL || "http://localhost:3003";
const PM_TIMEOUT = parseInt(process.env.PM_SERVICE_TIMEOUT || "10000", 10);

const pmApi = axios.create({ baseURL: PM_BASE_URL, timeout: PM_TIMEOUT });

const authHeaders = () => {
  const h = { "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET };
  const token = signServiceJwtEdDSA(); // PM verifies HR on the EdDSA internal lane
  if (token) h["X-Service-Authorization"] = `Bearer ${token}`;
  return h;
};

/**
 * @param {string|number} userId  RBAC user id (NOT the HR employeeId).
 * @returns {Promise<{available:boolean, items:Array, reason?:string}>}
 */
export async function getEmployeeProjects(userId) {
  if (!userId) return { available: false, items: [], reason: "no userId" };
  try {
    const res = await pmApi.get(`/api/employees/${encodeURIComponent(userId)}/projects`, {
      headers: authHeaders(),
    });
    const body = res?.data;
    const items = body?.data ?? body?.items ?? (Array.isArray(body) ? body : []);
    return { available: true, items: Array.isArray(items) ? items : [] };
  } catch (err) {
    logger.warn(
      { err: err?.message, userId, status: err?.response?.status },
      "pmProjects.client: projects fetch failed (cross-service auth may be pending)"
    );
    return {
      available: false,
      items: [],
      reason: err?.response?.status === 401 || err?.response?.status === 403 ? "cross-service auth pending" : err?.message || "unavailable",
    };
  }
}
