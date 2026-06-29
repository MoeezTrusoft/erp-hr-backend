import { AsyncLocalStorage } from "node:async_hooks";

export const mcpCtx = new AsyncLocalStorage();

function parseHeaderJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function getCtx() {
  const ctx = mcpCtx.getStore();
  if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  return ctx;
}

export function buildContextFromHeaders(req) {
  // T-P2.2/T-P2.6: the tenant is the VERIFIED RBAC Company.uuid claim the
  // gateway forwards alongside the x-user-* context family (x-tenant-id). It is
  // an opaque uuid STRING — pass it through verbatim, never coerce; absent →
  // null (fail-closed). Downstream mutations (e.g. hr_employee_create) scope the
  // write + the emitted lifecycle event by this value only, never the body.
  const rawTenant = req.headers["x-tenant-id"];
  const tenantId = typeof rawTenant === "string" && rawTenant.trim() ? rawTenant.trim() : null;
  // A.5: the request correlation id (minted by attachCorrelationId on the edge)
  // so an emitted EventEnvelope.correlationId chains HTTP → event end-to-end.
  const rawCorrelation = req.headers["x-correlation-id"] || req.correlationId;
  const correlationId =
    typeof rawCorrelation === "string" && rawCorrelation.trim() ? rawCorrelation.trim() : undefined;

  return {
    user: {
      userId: req.headers["x-user-id"],
      email: req.headers["x-user-email"],
      roles: parseHeaderJson(req.headers["x-user-roles"], []),
      isAdmin: req.headers["x-is-admin"] === "true",
      employeeId: req.headers["x-employee-id"],
      tenantId,
    },
    permissions: parseHeaderJson(req.headers["x-user-permissions"], {}),
    correlationId,
  };
}
