import { hasPermission, METHOD_ACTION } from "../mcp/utils/assertPermission.js";

const parseJsonHeader = (value, fallback) => {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const attachHrContext = (req, res, next) => {
  const userId = req.headers["x-user-id"] || req.headers["user-id"];
  const employeeId = req.headers["x-employee-id"] || req.headers["employee-id"];
  const roles = parseJsonHeader(req.headers["x-user-roles"], []);
  const permissions = parseJsonHeader(req.headers["x-user-permissions"], []);
  const isAdmin = req.headers["x-is-admin"] === "true";

  req.user = {
    userId: userId ? Number(userId) : null,
    employeeId: employeeId ? Number(employeeId) : null,
    email: req.headers["x-user-email"] || null,
    roles,
    role: roles[0] || null,
    permissions,
    isAdmin,
    // T-P2.1 / X-02: tenant is NOT taken from the spoofable x-tenant-id header.
    // It is sourced from the VERIFIED service-JWT claim by internalServiceGuard
    // (see internalService.middleware.js). Left null here; the guard fills it.
    tenantId: null,
  };

  next();
};

export const requireHrUser = (req, res, next) => {
  if (!req.user?.userId && !req.user?.employeeId) {
    return res.status(401).json({
      success: false,
      message: "Authentication context is required",
      errors: [{ code: "AUTH_CONTEXT_REQUIRED", message: "Missing user context" }],
      requestId: req.requestId,
    });
  }

  next();
};

// HR-03: deny-by-default authorization for the payroll surface (C4 data:
// salaries, bank accounts, tax). The payroll routes previously had NO authz at
// all, so any caller past the service boundary could read/run payroll. This
// middleware enforces the gateway-resolved entitlement (`req.user.permissions`,
// keyed by resource e.g. "hr:payroll") for the HTTP method's action. It NEVER
// honors the forgeable `x-is-admin` header — a real admin holds the permission.
//
//   requirePermission("hr:payroll")                — admin/org-wide routes
//   requirePermission("hr:payroll", { allowSelf }) — routes the controller
//       additionally self-scopes (employee viewing their OWN data); an EMPLOYEE
//       is allowed through and the controller enforces id-ownership.
export const requirePermission = (resourceKey, { allowSelf = false } = {}) => (req, res, next) => {
  const action = METHOD_ACTION[String(req.method).toUpperCase()];
  const perms = req.user?.permissions;
  if (action && hasPermission(perms, resourceKey, action)) return next();
  if (allowSelf && req.user?.role === "EMPLOYEE") return next(); // controller enforces ownership

  return res.status(403).json({
    success: false,
    message: "Forbidden",
    errors: [{ code: "FORBIDDEN", message: `Missing permission: ${resourceKey}:${action || "?"}` }],
    requestId: req.requestId,
  });
};
