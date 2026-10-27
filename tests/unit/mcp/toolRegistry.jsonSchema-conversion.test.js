// tests/unit/mcp/toolRegistry.jsonSchema-conversion.test.js
//
// GATE: every registered tool's input schema MUST convert through the MCP SDK's
// REAL JSON-Schema converter with the EXACT options the tools/list handler
// uses. Why this exists: one bad schema does not fail one tool — the SDK's
// ListToolsRequestHandler maps all _registeredTools inside one handler body, so
// a single crashing schema turns EVERY tools/list call into
// `-32603 Cannot read properties of undefined (reading '_zod')` and the whole
// hr_ surface disappears from every MCP client (gateway discovery included).
//
// This is exactly how hr_requisition_create/_update broke discovery wire-level
// (z.record(z.any()) under Zod v4.3.x). normalizeObjectSchema alone is NOT a
// sufficient gate — the crash lives in toJsonSchemaCompat — so this test runs
// the same two-step conversion the SDK does:
//
//   normalizeObjectSchema(tool.inputSchema)
//     → toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' })
//
// If a registration fails here, the error names the tool — no silent skips.

import { describe, it, expect } from "@jest/globals";
import { z } from "zod";

import { getMcpServer } from "../../../src/mcp/mcpServer.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

const LIST_OPTIONS = Object.freeze({ strictUnions: true, pipeStrategy: "input" });

describe("MCP tool registry — every tool converts to wire JSON Schema", () => {
  const tools = getMcpServer()._registeredTools || {};

  it("has a non-trivial registry to guard (registration itself must not regress)", () => {
    expect(Object.keys(tools).length).toBeGreaterThan(100);
  });

  it("every tool's inputSchema survives the exact tools/list conversion", () => {
    const failures = [];
    for (const [name, tool] of Object.entries(tools)) {
      try {
        const obj = normalizeObjectSchema(tool?.inputSchema);
        if (obj) toJsonSchemaCompat(obj, LIST_OPTIONS);
      } catch (err) {
        failures.push(`${name}: ${err?.message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("serializes string-keyed records with an explicit value schema", () => {
    const obj = normalizeObjectSchema(z.object({ attributes: z.record(z.string(), z.string()).optional() }));
    const schema = toJsonSchemaCompat(obj, LIST_OPTIONS);
    expect(schema.properties.attributes).toMatchObject({ type: "object", additionalProperties: { type: "string" } });
  });
});
