const METHOD_ACTION = {
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

function hasPermission(permissions, resourceKey, action) {
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

export function assertPermission(permissions, method, resourceKey, isAdmin) {
  if (isAdmin) return;
  const action = METHOD_ACTION[method.toUpperCase()];
  if (!action) return;
  if (!hasPermission(permissions, resourceKey, action)) {
    throw Object.assign(
      new Error(`Insufficient permissions: ${resourceKey}:${action}`),
      { status: 403 }
    );
  }
}
