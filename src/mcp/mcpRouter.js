import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getMcpServer } from "./mcpServer.js";
import { mcpCtx, buildContextFromHeaders } from "./context.js";
import logger from "../lib/logger.js";
import { toJsonRpcError } from "./utils/mcpErrorMap.js";

const router = express.Router();

router.post("/", express.json({ limit: "10mb" }), async (req, res) => {
  if (!req.headers["x-mcp-internal"]) {
    // REQ-HR-003: this used to answer a bare `{ error }` with no code and no
    // JSON-RPC envelope, so a peer service (PM) saw only "403" and could not
    // tell it apart from internalServiceGuard's rejection or a permission
    // denial — it cost a round of cross-team debugging. Name the requirement.
    logger.warn(
      { path: req.originalUrl, service: req.internalService?.service ?? null },
      "hr: /mcp call without x-mcp-internal",
    );
    return res.status(403).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: {
        code: -32003,
        message: "Direct MCP access not allowed: set the x-mcp-internal header on peer-service calls to HR /mcp",
        data: { code: "HR-0206" },
      },
    });
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
    // ERR-3/ERR-5: log the full error server-side; return a leak-safe JSON-RPC
    // error with the HR-nnnn in error.data.code (never the raw err.message).
    const jsonrpc = toJsonRpcError(err);
    logger.error(
      { err, code: jsonrpc.data.code, jsonrpcCode: jsonrpc.code, mcpRequestId: body?.id ?? null },
      "MCP request failed"
    );
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: jsonrpc,
        id: body?.id ?? null,
      });
    }
  } finally {
    await transport.close().catch(() => {});
  }
});

export default router;
