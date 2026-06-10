export function withToolError(fn, toolName = "unknown_tool") {
  return async (args) => {
    try {
      console.info(`[MCP HR] tool start ${toolName}`, { args });
      return await fn(args);
    } catch (err) {
      console.error(`[MCP HR] tool failed ${toolName}`, {
        args,
        message: err?.message,
        status: err?.status || 500,
        stack: err?.stack,
      });
      const body = { error: err.message, status: err.status || 500 };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(body) }],
      };
    }
  };
}
