import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./toolRegistry.js";

export function getMcpServer() {
  const server = new McpServer({
    name: "erp-hr-service",
    version: "1.0.0",
  });
  registerAllTools(server);
  return server;
}
