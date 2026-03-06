export function withToolError(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      const body = { error: err.message, status: err.status || 500 };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(body) }],
      };
    }
  };
}
