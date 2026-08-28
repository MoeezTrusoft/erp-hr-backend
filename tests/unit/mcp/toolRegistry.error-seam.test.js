// tests/unit/mcp/toolRegistry.error-seam.test.js
//
// HR-MCP-ERR-01 (ARCH-05 §6–§7, ARCH-01 §4/§13) — the central registration seam
// (toolRegistry.withSafeToolCallbacks) MUST sanitize any error a tool callback
// throws so the caller never sees raw Prisma/ORM/stack text, and the error
// carries the canonical { error, status, code, jsonrpc } envelope.
//
// This is the MCP twin of the REST terminal errorHandler and a defense-in-depth
// backstop behind the per-handler withToolError() wrapper: if ANY future handler
// forgets to wrap (or re-throws past the wrapper), the seam still guarantees a
// leak-safe 4xx/5xx result with an HR-nnnn code.
import { describe, it, expect } from "@jest/globals";

const { withSafeToolCallbacks, safeToolErrorResult } = await import(
  "../../../src/mcp/toolRegistry.js"
);

function makeMockServer() {
  const handlers = new Map();
  const server = {
    tool(name, ...rest) {
      handlers.set(name, rest[rest.length - 1]);
    },
  };
  return { server, handlers };
}

function prismaError(code, message) {
  const e = new Error(message);
  e.name = "PrismaClientKnownRequestError";
  e.code = code;
  e.meta = { cause: "boom" };
  return e;
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

describe("HR-MCP-ERR-01 — central error seam sanitization", () => {
  it("Prisma P2002 (conflict) → generic message, code P2002, status 409, NO raw leak", async () => {
    const { server, handlers } = makeMockServer();
    withSafeToolCallbacks(server);
    server.tool(
      "hr_err_prisma_dup",
      "desc",
      { id: "x" },
      async () => {
        throw prismaError("P2002", "Unique constraint failed on the fields: (`email`)");
      },
    );
    const res = await handlers.get("hr_err_prisma_dup")({});
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.code).toBe("P2002");
    expect(body.status).toBe(409);
    expect(body.error).not.toContain("Unique constraint");
    expect(body.error).not.toContain("email");
    expect(body.error).not.toContain("PrismaClientKnownRequestError");
  });

  it("Prisma P2024 (pool timeout) → 503, NO raw leak", async () => {
    const { server, handlers } = makeMockServer();
    withSafeToolCallbacks(server);
    server.tool(
      "hr_err_prisma_pool",
      "desc",
      { id: "x" },
      async () => {
        throw prismaError("P2024", "Timed out fetching a connection");
      },
    );
    const res = await handlers.get("hr_err_prisma_pool")({});
    const body = parse(res);
    expect(body.status).toBe(503);
    expect(body.error).not.toContain("Timed out fetching");
  });

  it("unauthenticated throw → HR-4010, status 401", async () => {
    const { server, handlers } = makeMockServer();
    withSafeToolCallbacks(server);
    server.tool(
      "hr_err_unauth",
      "desc",
      { id: "x" },
      async () => {
        throw Object.assign(new Error("Unauthenticated"), { status: 401 });
      },
    );
    const res = await handlers.get("hr_err_unauth")({});
    const body = parse(res);
    expect(body.code).toBe("HR-4010");
    expect(body.status).toBe(401);
  });

  it("unexpected raw Error → HR-5000, status 500, NO raw leak", async () => {
    const { server, handlers } = makeMockServer();
    withSafeToolCallbacks(server);
    server.tool(
      "hr_err_unknown",
      "desc",
      { id: "x" },
      async () => {
        throw new Error("db.host=10.0.0.5 password=secret SELECT * FROM users");
      },
    );
    const res = await handlers.get("hr_err_unknown")({});
    const body = parse(res);
    expect(body.code).toBe("HR-5000");
    expect(body.status).toBe(500);
    expect(body.error).not.toContain("db.host");
    expect(body.error).not.toContain("password");
    expect(body.error).not.toContain("SELECT");
  });

  it("safeToolErrorResult keeps happy-path returns untouched", async () => {
    const { server, handlers } = makeMockServer();
    withSafeToolCallbacks(server);
    server.tool(
      "hr_err_ok",
      "desc",
      { id: "x" },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const res = await handlers.get("hr_err_ok")({});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe("ok");
  });
});
