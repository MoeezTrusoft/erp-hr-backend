import { describe, it, expect } from "@jest/globals";
import { runController } from "../../../src/mcp/controllers/_runner.js";
const failure = (status, body) => runController((_req, res) => res.status(status).json(body), {});
describe("controller error envelopes through MCP", () => {
  it("preserves the standard nested error code, message and details", async () => {
    await expect(failure(409, { error: { code: "HR-6102", message: "Amendment reason required", details: { minimumLength: 10 } } }))
      .rejects.toMatchObject({ status: 409, code: "HR-6102", message: "Amendment reason required", details: { minimumLength: 10 } });
  });
  it("preserves flat precondition errors and current versions", async () => {
    await expect(failure(412, { code: "HR-4120", message: "Stale write", currentVersion: 7 }))
      .rejects.toMatchObject({ code: "HR-4120", currentVersion: 7, message: "Stale write" });
  });
  it("understands the route guard's errors array", async () => {
    await expect(failure(403, { errors: [{ code: "HR-0204", message: "Permission required" }] }))
      .rejects.toMatchObject({ status: 403, code: "HR-0204", message: "Permission required" });
  });
  it("keeps database diagnostics out of messages even in a nested envelope", async () => {
    await expect(failure(409, { error: { code: "HR-4090", message: "Unique constraint failed on private_table" } }))
      .rejects.toMatchObject({ message: "A record with this value already exists." });
  });
  it("does not stringify unknown objects into user-visible messages", async () => {
    await expect(failure(500, { error: { internal: "private" } })).rejects.toMatchObject({ message: "Request failed" });
  });
});
