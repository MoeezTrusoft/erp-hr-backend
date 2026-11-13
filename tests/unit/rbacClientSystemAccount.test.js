// tests/unit/rbacClientSystemAccount.test.js
//
// createRbacSystemAccount transport: HR provisions the RBAC login User by
// calling the RBAC MCP tool `rbac_employee_create` at POST {RBAC}/mcp (JSON-RPC
// tools/call) — NOT the REST route /api/employee (which needs a user Bearer
// token HR doesn't have and has no rbac:create check). /mcp is authorized via
// RBAC's internalServiceGuard + gatewayIdentity, so HR forwards its EdDSA
// service JWT + the acting user's X-User-* identity headers.
//
// These tests mock axios so we can assert the exact request the client makes and
// how it parses the MCP response (success from result.content[0].text; tool
// error from result.isError; JSON-RPC error; network error).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockRequest = jest.fn();
const mockSignServiceJwtEdDSA = jest.fn(() => "eddsa.hr.token");

// axios.create() → a fake instance whose .request we drive.
jest.unstable_mockModule("axios", () => ({
  default: { create: () => ({ request: mockRequest }) },
}));
// Deterministic service-JWT + tenant header so we can assert them.
jest.unstable_mockModule("../../src/lib/serviceJwt.js", () => ({
  signServiceJwtEdDSA: mockSignServiceJwtEdDSA,
  ambientTenantHeader: () => ({ "X-Tenant-Id": "tenant-abc" }),
}));

const { createRbacSystemAccount } = await import("../../src/services/rbac.client.js");
const { mcpCtx } = await import("../../src/mcp/context.js");

const PAYLOAD = {
  first_name: "Ada",
  last_name: "Lovelace",
  job_title: "Engineer",
  email: "ada@corp.example",
  phone: "+15551234567",
  gender: "female",
  hire_date: "2026-01-01T00:00:00.000Z",
  status: "Active",
  roles: [{ roleId: 7 }],
  password: "sup3rSecret!",
  hrEmployeeId: 101,
  mediaId: 555,
};

// Ambient acting-user context, exactly as buildContextFromHeaders would set it.
const CTX = {
  user: { userId: "42", email: "op@corp.example", employeeId: "9", roles: ["hr_admin"], isAdmin: false },
  permissions: ["rbac.employee.create", "hr.employee.read"],
  actorVerified: true,
};

const runInCtx = (fn) => mcpCtx.run(CTX, fn);

describe("rbac.client createRbacSystemAccount — MCP transport + authz forwarding", () => {
  beforeEach(() => jest.clearAllMocks());

  it("POSTs /mcp with the JSON-RPC tools/call envelope and rbac_employee_create args", async () => {
    mockRequest.mockResolvedValue({
      data: { jsonrpc: "2.0", id: "x", result: { content: [{ type: "text", text: JSON.stringify({ id: 9001 }) }] } },
    });

    const result = await runInCtx(() => createRbacSystemAccount(PAYLOAD));

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const req = mockRequest.mock.calls[0][0];
    expect(req.url).toBe("/mcp");
    expect(req.method).toBe("POST");
    expect(req.data).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "rbac_employee_create", arguments: PAYLOAD },
    });
    expect(typeof req.data.id).toBe("string"); // some request id present

    // Success parsed from result.content[0].text (created user JSON).
    expect(result).toEqual({ ok: true, user: { id: 9001 } });
  });

  it("F-03 sends the stable idempotency key and payload fingerprint", async () => {
    mockRequest.mockResolvedValue({
      data: { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ id: 9001 }) }] } },
    });
    const options = {
      idempotencyKey: "7406c980-4ca2-5c54-9071-36f33c4b35f8",
      payloadFingerprint: "a".repeat(64),
    };

    await runInCtx(() => createRbacSystemAccount(PAYLOAD, {}, options));

    const req = mockRequest.mock.calls[0][0];
    expect(req.data.id).toBe(options.idempotencyKey);
    expect(req.headers["Idempotency-Key"]).toBe(options.idempotencyKey);
    expect(req.headers["X-Idempotency-Fingerprint"]).toBe(options.payloadFingerprint);
  });

  it("forwards the EdDSA service JWT, tenant, internal secret, MCP accept, AND the acting user's X-User-* headers", async () => {
    mockRequest.mockResolvedValue({
      data: { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ id: 1 }) }] } },
    });

    await runInCtx(() => createRbacSystemAccount(PAYLOAD));
    const headers = mockRequest.mock.calls[0][0].headers;

    // Internal-plane auth (boundary: internalServiceGuard).
    expect(headers["X-Service-Authorization"]).toBe("Bearer eddsa.hr.token");
    expect(headers["X-Tenant-Id"]).toBe("tenant-abc");
    // MCP StreamableHTTP transport requires BOTH json + SSE accept.
    expect(headers["Accept"]).toBe("application/json, text/event-stream");
    expect(headers["Content-Type"]).toBe("application/json");
    // Acting-user identity (gatewayIdentity → assertPermission needs these).
    expect(headers["X-User-Id"]).toBe("42");
    expect(headers["X-User-Email"]).toBe("op@corp.example");
    expect(headers["X-Employee-Id"]).toBe("9");
    expect(headers["X-User-Roles"]).toBe(JSON.stringify(["hr_admin"]));
    expect(headers["X-User-Permissions"]).toBe(JSON.stringify(CTX.permissions));
    expect(headers["X-Is-Admin"]).toBe("false");
  });

  it("F-01 signs the verified ambient actor and canonical scope to match compatibility headers", async () => {
    mockRequest.mockResolvedValue({
      data: { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ id: 1 }) }] } },
    });

    await runInCtx(() => createRbacSystemAccount(PAYLOAD));

    expect(mockSignServiceJwtEdDSA).toHaveBeenCalledWith({
      userId: "42",
      email: "op@corp.example",
      employeeId: "9",
      roles: ["hr_admin"],
      scope: "rbac.employee.create hr.employee.read",
      permissions: ["rbac.employee.create", "hr.employee.read"],
    });
    const headers = mockRequest.mock.calls[0][0].headers;
    expect(JSON.parse(headers["X-User-Roles"])).toEqual(["hr_admin"]);
    expect(JSON.parse(headers["X-User-Permissions"])).toEqual(CTX.permissions);
  });

  it("F-01 never signs or forwards an unverified ambient header-shaped actor", async () => {
    mockRequest.mockResolvedValue({
      data: { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ id: 1 }) }] } },
    });
    const forged = {
      user: { userId: "999", email: "forged@example.test", employeeId: "999", roles: ["SUPER_ADMIN"] },
      permissions: ["rbac.employee.create"],
      actorVerified: false,
    };

    await mcpCtx.run(forged, () => createRbacSystemAccount(PAYLOAD, {
      "X-User-Id": "999",
      "X-User-Permissions": JSON.stringify(["rbac.employee.create"]),
    }));

    expect(mockSignServiceJwtEdDSA).toHaveBeenCalledWith({});
    const headers = mockRequest.mock.calls[0][0].headers;
    expect(headers["X-User-Id"]).toBeUndefined();
    expect(headers["X-User-Permissions"]).toBeUndefined();
  });

  it("F-01 does not attach user metadata to a verified service-only actor", async () => {
    mockRequest.mockResolvedValue({
      data: { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ id: 1 }) }] } },
    });
    const serviceOnly = {
      user: { userId: null, employeeId: null, roles: [] },
      permissions: ["rbac.employee.create"],
      actorVerified: true,
    };

    await mcpCtx.run(serviceOnly, () => createRbacSystemAccount(PAYLOAD));

    expect(mockSignServiceJwtEdDSA).toHaveBeenCalledWith({});
    const headers = mockRequest.mock.calls[0][0].headers;
    expect(headers["X-User-Roles"]).toBeUndefined();
    expect(headers["X-User-Permissions"]).toBeUndefined();
  });

  it("parses a text/event-stream (SSE) success frame", async () => {
    const frame =
      "event: message\n" +
      `data: ${JSON.stringify({ jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ id: 777 }) }] } })}\n\n`;
    mockRequest.mockResolvedValue({ data: frame });

    const result = await runInCtx(() => createRbacSystemAccount(PAYLOAD));
    expect(result).toEqual({ ok: true, user: { id: 777 } });
  });

  it("surfaces a tool-level error (result.isError → withToolError body) as ok:false", async () => {
    mockRequest.mockResolvedValue({
      data: {
        jsonrpc: "2.0",
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "Forbidden", status: 403, code: "RBAC-403" }) }],
        },
      },
    });

    const result = await runInCtx(() => createRbacSystemAccount(PAYLOAD));
    expect(result).toEqual({ ok: false, status: 403, error: "Forbidden", code: "RBAC-403" });
  });

  it("surfaces a JSON-RPC transport error (error.data.code) as ok:false", async () => {
    mockRequest.mockResolvedValue({
      data: { jsonrpc: "2.0", error: { code: -32601, message: "Method not found", data: { code: "NO-TOOL" } } },
    });

    const result = await runInCtx(() => createRbacSystemAccount(PAYLOAD));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Method not found");
    expect(result.code).toBe("NO-TOOL");
  });

  it("fails soft on a network/transport error (or boundary 401/403)", async () => {
    mockRequest.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED"), { response: { status: 403, data: { error: { message: "boundary denied" } } } })
    );

    const result = await runInCtx(() => createRbacSystemAccount(PAYLOAD));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toBe("boundary denied");
  });
});
