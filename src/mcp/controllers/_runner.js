export async function runController(controller, { user = {}, params = {}, query = {}, body = {} } = {}) {
  const primaryRole = Array.isArray(user.roles) && user.roles.length
    ? String(user.roles[0])
    : user.isAdmin
      ? "HR_ADMIN"
      : "EMPLOYEE";

  const req = {
    params,
    query,
    body,
    headers: {
      "user-id": user.userId ? String(user.userId) : "",
      "employee-id": user.employeeId ? String(user.employeeId) : "",
      "x-user-id": user.userId ? String(user.userId) : "",
      "x-employee-id": user.employeeId ? String(user.employeeId) : "",
      "x-internal": "true",
      "x-forwarded-for": "127.0.0.1",
    },
    user: {
      id: user.userId ? Number(user.userId) : undefined,
      userId: user.userId ? Number(user.userId) : undefined,
      employeeId: user.employeeId ? Number(user.employeeId) : undefined,
      email: user.email || undefined,
      role: primaryRole,
      roles: Array.isArray(user.roles) ? user.roles : [],
      isAdmin: !!user.isAdmin,
      // REQ-007: tenant is an opaque uuid string — pass it through, never coerce.
      tenantId: user.tenantId != null ? user.tenantId : undefined,
    },
    files: [],
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    connection: { remoteAddress: "127.0.0.1" },
    get(name) {
      return this.headers[String(name || "").toLowerCase()];
    },
  };

  let statusCode = 200;
  let payload;
  const headers = {};
  const res = {
    // Some controllers (file/artifact exports e.g. bank-file, tax-forms) stream
    // via res.setHeader(...).send(content). Record headers no-op-style so those
    // controllers run unchanged through the MCP boundary instead of throwing.
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
      return this;
    },
    set(name, value) {
      return this.setHeader(name, value);
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    status(code) {
      statusCode = Number(code) || 200;
      return this;
    },
    json(data) {
      payload = data;
      return this;
    },
    send(data) {
      payload = data;
      return this;
    },
    end(data) {
      if (data !== undefined) payload = data;
      return this;
    },
  };

  try {
    await controller(req, res);
  } catch (error) {
    throw Object.assign(new Error(error?.message || "Controller execution failed"), { status: 500 });
  }

  if (statusCode >= 400) {
    const message = payload?.message || payload?.error || "Request failed";
    const err = Object.assign(new Error(message), { status: statusCode, data: payload });
    // API-2 — preserve the HR-nnnn code and the optimistic-concurrency
    // currentVersion the controller surfaced (e.g. a 412 HR-4120) so the MCP
    // error mapper (toJsonRpcError) can emit -32009 with data.currentVersion.
    if (payload?.code) err.code = payload.code;
    if (payload?.currentVersion !== undefined) err.currentVersion = payload.currentVersion;
    throw err;
  }

  // A 204/empty controller (e.g. updateStage/updateStatus/delete) leaves payload
  // undefined. MCP tool handlers `JSON.stringify(data)` the result, and
  // JSON.stringify(undefined) === undefined produces an invalid tool content
  // item (text: undefined). Return a serializable success envelope instead so
  // every controller-backed tool yields valid content.
  return payload === undefined ? { success: true, statusCode } : payload;
}
