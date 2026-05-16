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
      tenantId: user.tenantId ? Number(user.tenantId) : undefined,
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
  const res = {
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
    throw Object.assign(new Error(message), { status: statusCode, data: payload });
  }

  return payload;
}
