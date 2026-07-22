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
  // SEC-5 / X-02 (MCP twin of the HR-03 REST fix): the tenant and the admin
  // flag are IDENTITY that must come from the VERIFIED service-JWT claim
  // (populated on req.internalService by internalServiceGuard, which runs
  // before this router — see app.js "/mcp" mount), NEVER from the spoofable
  // x-tenant-id / x-is-admin request headers. A mesh peer holding a valid
  // service JWT for tenant A could otherwise set x-tenant-id:<tenantB> +
  // x-is-admin:true and escalate cross-tenant + reveal C4 PII (salary/bank/
  // IBAN/NTN). Mirroring internalService.middleware.js lines 65-72, we take the
  // tenant from the verified claim only (opaque RBAC Company.uuid STRING — pass
  // through verbatim, never coerce), and fail closed to null when absent.
  const verified = req.internalService;
  const rawTenant = verified?.tenantId;
  const tenantId = typeof rawTenant === "string" && rawTenant.trim() ? rawTenant.trim() : null;
  // SEC-5: x-is-admin is client-forgeable and is NOT honored as authority. The
  // verified service-JWT carries no admin flag, so admin status fails closed to
  // false here — exactly as the REST path treats it (assertPermission ignores
  // the flag; C4-reveal paths require the hr:payroll VIEW grant). Gateway-
  // resolved entitlements still arrive via x-user-permissions behind the guard.
  const isAdmin = false;
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
      isAdmin,
      employeeId: req.headers["x-employee-id"],
      tenantId,
    },
    permissions: parseHeaderJson(req.headers["x-user-permissions"], {}),
    correlationId,
  };
}
