import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./toolRegistry.js";

let _server = null;

export function getMcpServer() {
  if (!_server) {
    _server = new McpServer({
      name: "erp-hr-service",
      version: "1.0.0",
    });
    registerAllTools(_server);
  }
  return _server;
}
