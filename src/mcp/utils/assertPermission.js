const METHOD_ACTION = {
  GET: "VIEW",
  POST: "CREATE",
  PUT: "EDIT",
  PATCH: "EDIT",
  DELETE: "DELETE",
};

export function assertPermission(permissions, method, resourceKey, isAdmin) {
  if (isAdmin) return;
  const action = METHOD_ACTION[method.toUpperCase()];
  if (!action) return;
  const allowed = permissions?.[resourceKey]?.includes(action);
  if (!allowed) {
    throw Object.assign(
      new Error(`Insufficient permissions: ${resourceKey}:${action}`),
      { status: 403 }
    );
  }
}
