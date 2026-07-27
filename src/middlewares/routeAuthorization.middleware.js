// F-02 / ARCH-00 P-02 / ARCH-01 §4.3 / ARCH-06 §6
// Authoritative REST authorization lives at one boundary. The service JWT
// proves which service called HR; its signed scope and actor claims determine
// what that call may do. Forwarded x-user-* headers are never authorization
// truth.
import { mcpCtx } from "../mcp/context.js";

const PROTECTED = Symbol("F-02-route-protected");

const METHOD_ACTION = Object.freeze({
  GET: "read",
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
});

const RESOURCE_PREFIXES = Object.freeze([
  ["/api/hr/requisitions", "hr.requisition"],
  ["/api/hr/positions", "hr.position"],
  ["/api/hr/employees", "hr.employee"],
  ["/api/hr/dashboard", "hr.employee"],
  ["/api/employee-media", "hr.employee"],
  ["/api/employee-lifecycle", "hr.employee"],
  ["/api/emergency-contacts", "hr.employee"],
  ["/api/dashboard-layout", "hr.employee"],
  ["/api/development-plans", "hr.performance"],
  ["/api/goal-alignments", "hr.performance"],
  ["/api/performancereview", "hr.performance"],
  ["/api/performance", "hr.performance"],
  ["/api/calibration", "hr.performance"],
  ["/api/goals", "hr.performance"],
  ["/api/time-attendance", "hr.attendance"],
  ["/api/attendance", "hr.attendance"],
  ["/api/reimbursements", "hr.reimbursement"],
  ["/api/requisitions", "hr.requisition"],
  ["/api/recruitment", "hr.recruitment"],
  ["/api/interviews", "hr.recruitment"],
  ["/api/talent-pool", "hr.recruitment"],
  ["/api/offers", "hr.recruitment"],
  ["/api/resume", "hr.recruitment"],
  ["/api/training-sessions", "hr.training"],
  ["/api/learning-paths", "hr.training"],
  ["/api/certifications", "hr.training"],
  ["/api/train_cat", "hr.training"],
  ["/api/enrollment", "hr.training"],
  ["/api/training", "hr.training"],
  ["/api/course", "hr.training"],
  ["/api/skills", "hr.training"],
  ["/api/onboarding", "hr.onboarding"],
  ["/api/offboarding", "hr.offboarding"],
  ["/api/org-chart", "hr.organization"],
  ["/api/compliance", "hr.compliance"],
  ["/api/analytics", "hr.analytics"],
  ["/api/holidays", "hr.leave"],
  ["/api/leaves", "hr.leave"],
  ["/api/payroll", "hr.payroll"],
  ["/api/benefits", "hr.benefits"],
  ["/api/positions", "hr.position"],
  ["/api/gdpr", "hr.gdpr"],
  ["/api/self", "hr.employee"],
  ["/api/employee", "hr.employee"],
  ["/api/log", "hr.audit"],
  ["/api/hr", "hr.employee"],
]);

const SERVICE_PRINCIPAL_POLICIES = Object.freeze({
  "POST /api/leaves/accruals/run": ["svc:hr-jobs"],
  "POST /api/performancereview/reminder": ["svc:hr-jobs"],
  "POST /api/attendance/device/sync": ["svc:attendance"],
  "POST /api/attendance/device/connectivity": ["svc:attendance"],
  "GET /api/attendance/device/daily-summary": ["svc:attendance"],
});

const normalizePath = (req) => {
  const raw = req.originalUrl || req.path || "";
  const path = raw.split("?", 1)[0].replace(/\/+$/, "") || "/";
  return path.toLowerCase();
};

const scopeSet = (claims) => {
  const raw = claims?.scope ?? claims?.permissions;
  if (Array.isArray(raw)) return new Set(raw.filter((item) => typeof item === "string"));
  if (typeof raw === "string") return new Set(raw.split(/[\s,]+/).filter(Boolean));
  return new Set();
};

const resourceFor = (path) => RESOURCE_PREFIXES.find(([prefix]) =>
  path === prefix || path.startsWith(`${prefix}/`)
)?.[1] || null;

const actionFor = (method, path) => {
  if (method === "POST" && path === "/api/payroll/runs") return "run";
  if (path.includes("/payroll/runs/") && path.endsWith("/approve")) return "approve";
  if (path.includes("/payroll/runs/") && path.endsWith("/finalize")) return "post";
  if (path.includes("/payroll/runs/") && path.endsWith("/process")) return "run";
  if (path.endsWith("/bank-file") || path.includes("/export")) return "export";
  if (path.includes("/approve") || path.includes("/reject")) return "approve";
  if (path === "/api/leaves/accruals/run") return "run";
  if (path === "/api/leaves/requests" && method === "POST") return "write";
  if (path.includes("/leaves/requests/") && path.endsWith("/cancel")) return "write";
  if (path === "/api/attendance/checkin" || path === "/api/attendance/checkout") return "self";
  if (path.startsWith("/api/self/")) return "self";
  return METHOD_ACTION[method] || null;
};

const verifiedActor = (req) => {
  const claims = req.internalService?.claims;
  if (!claims || typeof claims !== "object") return null;
  const userId = claims.userId ?? claims.uid ?? null;
  const employeeId = claims.employeeId ?? claims.eid ?? null;
  const roles = Array.isArray(claims.roles) ? claims.roles : [];
  return {
    principal: String(claims.sub || req.internalService?.service || ""),
    userId,
    employeeId,
    email: claims.email ?? claims.userEmail ?? null,
    roles,
    permissions: scopeSet(claims),
  };
};

const sameId = (left, right) => left != null && right != null && String(left) === String(right);

const ownsSelfObject = (req, path, actor) => {
  if (!actor.employeeId) return false;
  if (path.startsWith("/api/self/")) return true;
  if (path === "/api/attendance/checkin" || path === "/api/attendance/checkout") {
    return sameId(req.body?.employeeId, actor.employeeId);
  }
  const attendance = path.match(/^\/api\/attendance\/get-attandance\/([^/]+)$/);
  if (attendance) return sameId(attendance[1], actor.employeeId);
  const employeePath = path.match(/\/employees?\/([^/]+)/);
  if (employeePath) return sameId(employeePath[1], actor.employeeId);
  return false;
};

export function resolveHrRoutePolicy(req) {
  // req.route exists only after Express matched a declared route. The terminal
  // /api fallback has no req.route and is therefore an unknown mapping: deny.
  if (!req.route) return null;
  const method = String(req.method || "").toUpperCase();
  const path = normalizePath(req);
  const resource = resourceFor(path);
  const action = actionFor(method, path);
  if (!resource || !action) return null;

  const key = `${method} ${path}`;
  const servicePrincipals = SERVICE_PRINCIPAL_POLICIES[key] || [];
  const permission = `${resource}.${action}`;
  const controllerOwnership = method === "GET" && (
    /^\/api\/payroll\/payslips\/[^/]+$/.test(path) ||
    path === "/api/leaves/requests" ||
    /^\/api\/leaves\/requests\/[^/]+$/.test(path)
  );
  const inlineOwnership = action === "self" ||
    (method === "GET" && (/\/employees?\//.test(path) ||
      path.startsWith("/api/attendance/get-attandance/"))) ||
    (method === "POST" && path === "/api/leaves/requests");
  const self = inlineOwnership || controllerOwnership;
  return {
    permission,
    resource,
    action,
    self,
    ownership: inlineOwnership ? "inline" : controllerOwnership ? "controller" : null,
    servicePrincipals,
  };
}

const deny = (req, res, code, message) => res.status(403).json({
  success: false,
  message: "Forbidden",
  errors: [{ code, message }],
  requestId: req.requestId,
});

const syncVerifiedAmbientActor = (req) => {
  const store = mcpCtx.getStore();
  if (!store) return;
  store.user = req.user;
  store.permissions = [...(req.authz?.actor?.permissions || [])];
  store.actorVerified = true;
  store.authz = req.authz;
};

export function authorizeHrRoute(req, res, next) {
  const policy = resolveHrRoutePolicy(req);
  if (!policy) return deny(req, res, "HR-0201", "No declared authorization policy for route");

  const actor = verifiedActor(req);
  if (!actor) return deny(req, res, "HR-0202", "Verified actor context is required");

  const isHuman = actor.userId != null || actor.employeeId != null;
  if (!isHuman) {
    if (!policy.servicePrincipals.includes(actor.principal)) {
      return deny(req, res, "HR-0203", "Service principal is not allowed on this route");
    }
    if (!actor.permissions.has(policy.permission)) {
      return deny(req, res, "HR-0204", `Missing permission: ${policy.permission}`);
    }
    req.authz = { actor, policy, type: "service" };
    req.user = {
      userId: null,
      employeeId: null,
      email: null,
      principal: actor.principal,
      roles: actor.roles,
      role: actor.roles[0] || null,
      permissions: [...actor.permissions],
      isAdmin: false,
      tenantId: req.internalService?.tenantId ?? req.internalService?.claims?.tid ?? null,
    };
    syncVerifiedAmbientActor(req);
    return next();
  }

  let granted = actor.permissions.has(policy.permission);
  const ownsInline = ownsSelfObject(req, normalizePath(req), actor) ||
    (normalizePath(req) === "/api/leaves/requests" &&
      sameId(req.body?.employeeId ?? req.body?.createdById, actor.employeeId));
  const controllerWillEnforce = policy.ownership === "controller" &&
    actor.roles.includes("EMPLOYEE");
  if (!granted && policy.self && (controllerWillEnforce || ownsInline)) {
    granted = actor.permissions.has(`${policy.resource}.self`);
  }
  if (!granted) return deny(req, res, "HR-0204", `Missing permission: ${policy.permission}`);
  if (policy.ownership === "inline" && !ownsInline) {
    return deny(req, res, "HR-0205", "Employee object is not owned by the actor");
  }

  // Controllers receive only the signed actor identity. Replacing the forwarded
  // identity fields also closes legacy controller reads of employee-id headers.
  const tenantId = req.internalService?.tenantId ?? req.internalService?.claims?.tid ?? null;
  req.user = {
    userId: actor.userId,
    employeeId: actor.employeeId,
    email: actor.email,
    roles: actor.roles,
    role: actor.roles[0] || null,
    permissions: [...actor.permissions],
    isAdmin: false,
    tenantId,
  };
  req.authz = { actor, policy, type: "user" };
  syncVerifiedAmbientActor(req);
  if (actor.userId != null) req.headers["user-id"] = String(actor.userId);
  if (actor.employeeId != null) {
    req.headers["employee-id"] = String(actor.employeeId);
    req.headers["x-employee-id"] = String(actor.employeeId);
  }
  return next();
}

const walkRouteLayers = (router, visitor) => {
  for (const layer of router?.stack || []) {
    if (layer.route) visitor(layer.route);
    if (!layer.route && layer.handle?.stack) walkRouteLayers(layer.handle, visitor);
  }
};

export function protectHrRouter(router) {
  walkRouteLayers(router, (route) => {
    const protectedMethods = new Set();
    for (const layer of route.stack || []) {
      const method = layer.method || "_all";
      if (protectedMethods.has(method)) continue;
      if (layer[PROTECTED]) {
        protectedMethods.add(method);
        continue;
      }
      const original = layer.handle;
      layer.handle = function f02AuthorizedHandler(req, res, next) {
        return authorizeHrRoute(req, res, (error) => error ? next(error) : original(req, res, next));
      };
      layer[PROTECTED] = true;
      protectedMethods.add(method);
    }
  });
  return router;
}

export function routeProtectionCoverage(router) {
  let declared = 0;
  let protectedCount = 0;
  walkRouteLayers(router, (route) => {
    for (const method of Object.keys(route.methods || {})) {
      if (method === "_all") continue;
      declared += 1;
      if (route.stack?.some((layer) => layer[PROTECTED] &&
        (layer.method === method || layer.method == null))) protectedCount += 1;
    }
  });
  return { declared, protected: protectedCount };
}

export function mountAuthorizedHrRouter(app, path, router) {
  protectHrRouter(router);
  const coverage = routeProtectionCoverage(router);
  if (!resourceFor(String(path).toLowerCase()) || coverage.declared === 0 ||
    coverage.declared !== coverage.protected) {
    throw new Error(`F-02 uncovered HR routes at ${path}`);
  }
  app.use(path, router);
}

export function denyUnknownHrRoute(req, res) {
  return deny(req, res, "HR-0201", "No declared authorization policy for route");
}
