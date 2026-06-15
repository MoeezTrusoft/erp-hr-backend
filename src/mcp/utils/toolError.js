import logger from "../../lib/logger.js";

export function withToolError(fn, toolName = "unknown_tool") {
  return async (args) => {
    try {
      logger.debug({ toolName, args }, "MCP tool start");
      return await fn(args);
    } catch (err) {
      logger.error({
        toolName,
        args,
        err,
        status: err?.status || 500,
      }, "MCP tool failed");
      const body = { error: err.message, status: err.status || 500 };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(body) }],
      };
    }
  };
}
