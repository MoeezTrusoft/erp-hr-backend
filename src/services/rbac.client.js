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
import { signServiceJwtEdDSA } from "../lib/serviceJwt.js";

const RBAC_BASE_URL = process.env.RBAC_SERVICE_URL || "http://localhost:3001";
const RBAC_TIMEOUT = parseInt(process.env.RBAC_SERVICE_TIMEOUT || "10000", 10);

const rbacApi = axios.create({ baseURL: RBAC_BASE_URL, timeout: RBAC_TIMEOUT });

const withInternalAuth = (headers = {}) => {
  const merged = { ...headers, "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET };
  const token = signServiceJwtEdDSA(); // RBAC verifies HR on the EdDSA plane
  if (token) merged["X-Service-Authorization"] = `Bearer ${token}`;
  return merged;
};

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
