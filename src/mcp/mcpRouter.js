import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getMcpServer } from "./mcpServer.js";
import { mcpCtx, buildContextFromHeaders } from "./context.js";
import logger from "../lib/logger.js";

const router = express.Router();

router.post("/", express.json({ limit: "10mb" }), async (req, res) => {
  if (!req.headers["x-mcp-internal"]) {
    return res.status(403).json({ error: "Direct MCP access not allowed" });
  }

  const body = req.body;

  // Defensive normalization for MCP transport negotiation headers.
  const accept = String(req.headers.accept || "");
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    req.headers.accept = "application/json, text/event-stream";
  }
  if (!req.headers["mcp-protocol-version"]) {
    req.headers["mcp-protocol-version"] = body?.params?.protocolVersion || "2024-11-05";
  }

  const ctx = buildContextFromHeaders(req);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = getMcpServer();

  try {
    await mcpCtx.run(ctx, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });
  } catch (err) {
    logger.error({ err, mcpRequestId: body?.id ?? null }, "MCP request failed");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: body?.id ?? null,
      });
    }
  } finally {
    await transport.close().catch(() => {});
  }
});

export default router;
