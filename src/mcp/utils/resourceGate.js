// src/mcp/utils/resourceGate.js — HR-MCP-RESOURCE-01 (2026-11-28).
//
// MCP resources (`resources/read`) bypass the gateway's tools/call precheck, and
// most HR resources were registered without any permission check: a plain
// employee could read hr://payroll/payslips (every colleague's pay),
// hr://employees, hr://compliance/gdpr-records and more. Every resource now
// passes one gate, chosen by URI at registration, mirroring what the matching
// tools require. Anything not listed here is refused (fail closed).
import { hasPermission } from "./assertPermission.js";
import {
  assertPayrollAdminSurface,
  canViewOthersLeave,
  resolveAttendanceReadScope,
} from "./actorScope.js";

const deny = (what) => {
  throw Object.assign(new Error(`Insufficient permissions: ${what}`), {
    status: 403,
    statusCode: 403,
    code: "HR-4030",
  });
};

const open = () => {};
const view = (key) => (_user, permissions) => {
  if (!hasPermission(permissions, key, "VIEW")) deny(`${key}:VIEW`);
};
// Company-wide rows: the caller must be on that module's admin (write/export) surface.
const others = (check, what) => (user, permissions) => {
  if (!check(user, permissions)) deny(what);
};

// Ordered: the first match wins.
const RULES = [
  // The acting employee's own rows — each handler scopes to the verified session.
  [/^hr:\/\/self\//, open],
  // Company-wide reference data every employee needs to request leave.
  [/^hr:\/\/(holidays|leaves\/policies)$/, open],
  [/^hr:\/\/payroll\//, (_u, p) => assertPayrollAdminSurface(p)],
  [/^hr:\/\/leaves\//, others(canViewOthersLeave, "company leave needs the HR leave surface")],
  [/^hr:\/\/overtime-rules$/, view("hr:attendance")],
  [
    /^hr:\/\/(attendance|timesheets|time-entries|work-schedules)(\/|$)/,
    others((u, p) => resolveAttendanceReadScope(u, p).canViewOthers, "company attendance needs the attendance admin surface"),
  ],
  [/^hr:\/\/(employees|positions|org-chart)$/, view("hr:employee")],
  [/^hr:\/\/analytics\//, view("hr:analytics")],
  [/^hr:\/\/compliance\//, view("hr:compliance")],
  [/^hr:\/\/benefits\//, view("hr:benefits")],
  [/^hr:\/\/(training\/|learning-paths$|certifications$|skills$)/, view("hr:learning")],
  [/^hr:\/\/onboarding\//, view("hr:onboarding")],
  [/^hr:\/\/(performance\/|goals$|calibration$)/, view("hr:performance")],
  [/^hr:\/\/recruitment\//, view("hr:recruitment")],
];

const unknown = (uri) => () => deny(`no access rule for ${uri}`);

export function resourceGateFor(uri) {
  const hit = RULES.find(([re]) => re.test(uri));
  return hit ? hit[1] : unknown(uri);
}

// Wrap server.resource so every handler runs its gate first. `getCtx` returns the
// verified request context ({ user, permissions }).
export function withResourceGates(server, getCtx) {
  if (server.__hrResourceGated) return server;
  const original = server.resource.bind(server);
  server.resource = (name, uriOrTemplate, ...rest) => {
    const cbIndex = rest.length - 1;
    if (typeof rest[cbIndex] !== "function") return original(name, uriOrTemplate, ...rest);
    const uri = typeof uriOrTemplate === "string" ? uriOrTemplate : String(uriOrTemplate?.uriTemplate ?? "");
    const gate = resourceGateFor(uri);
    const handler = rest[cbIndex];
    rest[cbIndex] = async (...args) => {
      const ctx = getCtx();
      if (!ctx?.user) throw Object.assign(new Error("Unauthenticated"), { status: 401 });
      gate(ctx.user, ctx.permissions);
      return handler(...args);
    };
    return original(name, uriOrTemplate, ...rest);
  };
  server.__hrResourceGated = true;
  return server;
}
