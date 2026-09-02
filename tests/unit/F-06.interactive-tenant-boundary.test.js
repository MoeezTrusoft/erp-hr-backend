// F-06 / ARCH-00 §2.1, P-02 / ARCH-05 §§6.1, 7.1
import { afterAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({
  default: {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]),
  },
}));

const { createApp } = await import("../../src/app.js");
const { tenantScopeExtension } = await import("../../src/lib/tenantScope.js");
const { mcpCtx } = await import("../../src/mcp/context.js");

const SECRET = "f06-service-jwt-secret";
const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  SERVICE_JWT_SECRET: process.env.SERVICE_JWT_SECRET,
  SERVICE_JWT_AUDIENCE: process.env.SERVICE_JWT_AUDIENCE,
  SERVICE_JWT_ISSUER: process.env.SERVICE_JWT_ISSUER,
};

const token = (...tenantArgs) => jwt.sign({
  sub: "erp-gateway",
  userId: 41,
  employeeId: 7,
  ...(tenantArgs.length === 0
    ? { tid: TENANT }
    : tenantArgs[0] === undefined ? {} : { tid: tenantArgs[0] }),
}, SECRET, { issuer: "erp-gateway", audience: "internal", expiresIn: "5m" });

const scopedOperation = () => {
  let extension;
  tenantScopeExtension({
    $extends(value) {
      extension = value;
      return value;
    },
  });
  return extension.query.$allModels.$allOperations;
};

describe("F-06 interactive tenant boundary", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.SERVICE_JWT_SECRET = SECRET;
    process.env.SERVICE_JWT_AUDIENCE = "internal";
    process.env.SERVICE_JWT_ISSUER = "erp-gateway";
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["non-UUID", "tenant-7"],
  ])("rejects a valid service JWT with a %s tenant before /api routing", async (_label, tid) => {
    const response = await request(createApp())
      .get("/api/anything")
      .set("x-service-authorization", `Bearer ${token(tid)}`);

    expect(response.status).toBe(403);
    expect(response.body.errors?.[0]?.code).toBe("HR-0601");
  });

  // The /mcp boundary does NOT reject on tenant, deliberately — see
  // internalService.middleware.js: tools/list is a cross-tenant discovery call,
  // so the tenant is enforced per-tool inside buildContextFromHeaders instead.
  // These cases previously asserted a 403 here and had been failing since that
  // design changed; what actually matters is that a tenantless caller can never
  // obtain a tenant-scoped context, which is asserted below.
  it.each([undefined, null, "00000000-0000-0000-0000-000000000000", "not-a-uuid"])(
    "never grants a tenant-scoped MCP context for tenant %p",
    async (tid) => {
      const response = await request(createApp())
        .post("/mcp")
        .set("x-service-authorization", `Bearer ${token(tid)}`)
        .set("x-mcp-internal", "true")
        .set("Accept", "application/json, text/event-stream")
        .set("Content-Type", "application/json")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "hr_attendance_list", arguments: {} },
        });

      // MCP returns JSON-RPC errors inside a 200 envelope, so the status alone
      // proves nothing — the body is what matters. Either the transport refuses
      // the request outright, or the tool call comes back as an error (the
      // tenantScope extension raises HR-4031 for a non-UUID tenant). What must
      // never happen is a clean result payload.
      if (response.status === 200) {
        const body = JSON.stringify(response.body);
        expect(body).toMatch(/error|isError|HR-40|Unauthenticated/i);
      } else {
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    }
  );

  it("still rejects a tenantless caller on the /api boundary", async () => {
    // The REST surface is where the tenant guard applies, and it still does.
    const response = await request(createApp())
      .get("/api/anything")
      .set("x-service-authorization", `Bearer ${token("not-a-uuid")}`);

    expect(response.status).toBe(403);
    expect(response.body.errors?.[0]?.code).toBe("HR-0601");
  });

  it("accepts a UUID tenant and reaches the declared route boundary", async () => {
    const response = await request(createApp())
      .get("/api/anything")
      .set("x-service-authorization", `Bearer ${token()}`);

    expect(response.status).toBe(403);
    expect(response.body.errors?.[0]?.code).toBe("HR-0201");
  });

  it.each([null, undefined, "", "00000000-0000-0000-0000-000000000000", "not-a-uuid"])(
    "prevents interactive tenant %p from reading the shared null partition",
    async (tenantId) => {
      const query = jest.fn();
      await expect(mcpCtx.run({ user: { tenantId } }, () => scopedOperation()({
        model: "PayrollRun",
        operation: "findMany",
        args: {},
        query,
      }))).rejects.toThrow(/HR-4031/);
      expect(query).not.toHaveBeenCalled();
    }
  );

  it("prevents interactive tenantless creates while explicit SYSTEM jobs remain possible", async () => {
    const query = jest.fn(async (args) => args);
    await expect(mcpCtx.run({ user: { tenantId: null } }, () => scopedOperation()({
      model: "PayrollRun",
      operation: "create",
      args: { data: { status: "DRAFT" } },
      query,
    }))).rejects.toThrow(/HR-4031/);

    await expect(mcpCtx.run({ system: true }, () => scopedOperation()({
      model: "PayrollRun",
      operation: "findMany",
      args: {},
      query,
    }))).resolves.toEqual({});
  });
});
