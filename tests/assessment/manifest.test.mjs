import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
process.env.NODE_ENV = "test";
test("The actual MCP SDK advertises all commands as object schemas and retains strict context confirmation", async () => {
  const { registerAssessmentTools, assessmentTools } =
    await import("../../src/mcp/tools/assessmentTools.js");
  const server = new McpServer({
      name: "assessment-manifest-test",
      version: "1.0.0",
    }),
    client = new Client({ name: "assessment-test", version: "1.0.0" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  registerAssessmentTools(server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, assessmentTools.length);
    for (const tool of tools)
      assert.equal(tool.inputSchema.type, "object", tool.name);
    const observation = tools.find(
      (t) => t.name === "hr_assessment_observation_save",
    );
    assert.ok(observation.inputSchema.required.includes("contextConfirmed"));
    const admin = tools.find((t) => t.name === "hr_assessment_admin");
    assert.ok(admin.inputSchema.properties.answers);
    assert.ok(admin.inputSchema.properties.scopes);
  } finally {
    await client.close();
    await server.close();
  }
});
