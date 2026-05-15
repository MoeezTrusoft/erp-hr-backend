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
    tenantId: req.headers["x-tenant-id"] ? Number(req.headers["x-tenant-id"]) : null,
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
