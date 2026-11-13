// Loopback-only browser fixture: real service code and disposable PostgreSQL.
import http from "node:http";
import { setup, fixture, as, people, company, prisma } from "./fixtures.mjs";
import { approvalHandlers } from "../../src/mcp/tools/approvalTools.js";
await setup();
const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    const url = new URL(req.url, "http://127.0.0.1:5377");
    if (url.pathname === "/health") {
      res.end(JSON.stringify({ ready: true }));
      return;
    }
    if (url.pathname === "/fixture") {
      const source = await fixture(url.searchParams.get("kind") || "CLAIM");
      res.end(
        JSON.stringify({
          kind: source.kind,
          sourceRef: source.ref,
          employeeCode: people.EMPLOYEE.employee_code,
          company,
        }),
      );
      return;
    }
    if (url.pathname !== "/rpc" || req.method !== "POST") {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    const role = req.headers["x-test-role"];
    if (
      !["EMPLOYEE", "MANAGER", "HR", "MANAGEMENT", "OTHER", "ADMIN"].includes(
        role,
      )
    ) {
      res.statusCode = 403;
      res.end("{}");
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 65536) throw new Error("Request too large");
    }
    const { name, input } = JSON.parse(body);
    if (!approvalHandlers[name]) throw new Error("Unknown tool");
    const result = await as(role, () => approvalHandlers[name](input));
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = error.status || 500;
    res.end(JSON.stringify({ message: error.message, status: res.statusCode }));
  }
});
server.listen(5377, "127.0.0.1");
process.on("SIGTERM", () =>
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  }),
);
