import { AsyncLocalStorage } from "node:async_hooks";

export const mcpCtx = new AsyncLocalStorage();

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
  // tenant from the verified claim only (opaque RBAC Company.uuid STRING). F-06
  // rejects an absent/non-UUID claim in internalServiceGuard before this router.
  const verified = req.internalService;
  const rawTenant = verified?.tenantId;
  const tenantId = typeof rawTenant === "string" && rawTenant.trim() ? rawTenant.trim() : null;
  // SEC-5: x-is-admin is client-forgeable and is NOT honored as authority. The
  // verified service-JWT carries no admin flag, so admin status fails closed to
  // false here. Actor identity and canonical scope below come from its verified
  // claims; compatibility X-User-* headers are not authorization inputs.
  const isAdmin = false;
  const claims = verified?.claims || {};
  const rawScope = claims.scope ?? claims.permissions;
  const permissions = Array.isArray(rawScope)
    ? rawScope.filter((item) => typeof item === "string")
    : typeof rawScope === "string"
      ? rawScope.split(/[\s,]+/).filter(Boolean)
      : [];
  // A.5: the request correlation id (minted by attachCorrelationId on the edge)
  // so an emitted EventEnvelope.correlationId chains HTTP → event end-to-end.
  const rawCorrelation = req.headers["x-correlation-id"] || req.correlationId;
  const correlationId =
    typeof rawCorrelation === "string" && rawCorrelation.trim() ? rawCorrelation.trim() : undefined;

  return {
    user: {
      userId: claims.userId ?? claims.uid ?? null,
      email: claims.email ?? claims.userEmail ?? null,
      roles: Array.isArray(claims.roles) ? claims.roles : [],
      isAdmin,
      employeeId: claims.employeeId ?? claims.eid ?? null,
      tenantId,
    },
    permissions,
    correlationId,
    actorVerified: true,
  };
}
