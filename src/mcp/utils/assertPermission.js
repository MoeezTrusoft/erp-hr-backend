export const METHOD_ACTION = {
  GET: "VIEW",
  POST: "CREATE",
  PUT: "EDIT",
  PATCH: "EDIT",
  DELETE: "DELETE",
};

const ACTION_TO_BIT = {
  VIEW: 1,
  CREATE: 2,
  EDIT: 4,
  DELETE: 8,
  EXPORT: 16,
};

export function hasPermission(permissions, resourceKey, action) {
  const granted = permissions?.[resourceKey];
  if (!granted) return false;
  if (Array.isArray(granted)) return granted.includes(action);
  if (typeof granted === "number") return (granted & ACTION_TO_BIT[action]) === ACTION_TO_BIT[action];
  if (typeof granted === "string") return granted.split(",").map((item) => item.trim()).includes(action);
  if (typeof granted === "object") {
    const actions = granted.actions || granted.permissions || granted.allowedActions;
    if (Array.isArray(actions)) return actions.includes(action);
    if (typeof actions === "number") return (actions & ACTION_TO_BIT[action]) === ACTION_TO_BIT[action];
  }
  return false;
}

export function assertPermission(permissions, method, resourceKey, _isAdmin) {
  // HR-03: the `isAdmin` blanket bypass is REMOVED. It was derived from the
  // client-supplied `x-is-admin` header (hrContext.middleware.js), so a forged
  // header granted full access. Authorization is now purely permission-based
  // (deny-by-default); a real admin carries the resource permissions in their
  // entitlement blob. The param is kept for call-site compatibility, unused.
  const action = METHOD_ACTION[method.toUpperCase()];
  if (!action) return;
  if (!hasPermission(permissions, resourceKey, action)) {
    throw Object.assign(
      new Error(`Insufficient permissions: ${resourceKey}:${action}`),
      { status: 403 }
    );
  }
}
