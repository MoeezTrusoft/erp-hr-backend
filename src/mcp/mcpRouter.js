import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getMcpServer } from "./mcpServer.js";
import { mcpCtx, buildContextFromHeaders } from "./context.js";
import logger from "../lib/logger.js";
import { toJsonRpcError } from "./utils/mcpErrorMap.js";

const router = express.Router();

router.post("/", express.json({ limit: "10mb" }), async (req, res) => {
  logger.info({ method: req.body?.method, path: req.originalUrl }, "hr: /mcp request received");

  if (!req.headers["x-mcp-internal"]) {
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

  logger.info({ method: body?.method }, "hr: creating transport and server");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = getMcpServer();
  logger.info({ method: body?.method, toolCount: Object.keys(server._registeredTools || {}).length }, "hr: server created with tools");

  // Diagnostic: catch the _zod crash in tools/list and log which tool causes it
  if (body?.method === "tools/list") {
    logger.info("hr: running tools/list diagnostic pre-check");
    const tools = server._registeredTools || {};
    let failedTool = null;
    for (const [name, tool] of Object.entries(tools)) {
      if (tool?.inputSchema) {
        try {
          const { normalizeObjectSchema } = await import("@modelcontextprotocol/sdk/server/zod-compat.js");
          normalizeObjectSchema(tool.inputSchema);
        } catch (e) {
          failedTool = name;
          logger.error({ toolName: name, err: e?.message, stack: e?.stack?.substring(0, 500), inputSchemaType: typeof tool.inputSchema, keys: Object.keys(tool.inputSchema || {}).slice(0, 5) }, "HR tool schema serialization failed");
        }
      }
    }
    if (failedTool) {
      logger.error({ failedTool }, "hr: tools/list diagnostic found failing tool");
    } else {
      logger.info("hr: tools/list diagnostic passed all tools");
    }
  }

  try {
    logger.info({ method: body?.method }, "hr: connecting transport");
    await mcpCtx.run(ctx, async () => {
      await server.connect(transport);
      logger.info({ method: body?.method }, "hr: handling request via transport");
      await transport.handleRequest(req, res, body);
      logger.info({ method: body?.method }, "hr: request handled successfully");
    });
  } catch (err) {
    const jsonrpc = toJsonRpcError(err);
    logger.error(
      { err: err?.message, stack: err?.stack?.substring(0, 1000), code: jsonrpc.data.code, jsonrpcCode: jsonrpc.code, mcpRequestId: body?.id ?? null },
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
    logger.info({ method: body?.method }, "hr: transport closed");
  }
});

export default router;
