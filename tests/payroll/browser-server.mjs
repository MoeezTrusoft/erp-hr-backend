import http from "node:http";
import { z } from "zod";
import { setupPayroll, people, company, as, prisma } from "./fixtures.mjs";
import { mcpCtx } from "../../src/mcp/context.js";
import { approvalHandlers } from "../../src/mcp/tools/approvalTools.js";
import { registerPayrollTools } from "../../src/mcp/tools/payrollTools.js";
import { registerPayrollPreviewTools } from "../../src/mcp/tools/payrollPreviewTools.js";
import { registerPayrollSetupActionsTools } from "../../src/mcp/tools/payrollSetupActionsTools.js";
const { run } = await setupPayroll();
const handlers = new Map();
const registry = {
  tool: (name, description, schema, handler) =>
    handlers.set(name, {
      schema: schema?.parse ? schema : z.object(schema),
      handler,
    }),
  resource: () => {},
};
registerPayrollTools(registry);
registerPayrollPreviewTools(registry);
registerPayrollSetupActionsTools(registry);
const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    if (req.url === "/health") {
      res.end(JSON.stringify({ ready: true }));
      return;
    }
    if (req.url === "/fixture") {
      res.end(
        JSON.stringify({
          runId: run.id,
          kind: "PAYROLL",
          sourceRef: String(run.id),
          employeeCode: people.EMPLOYEE.employee_code,
          company,
        }),
      );
      return;
    }
    if (req.url !== "/rpc" || req.method !== "POST") {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    const role = req.headers["x-test-role"];
    if (!people[role])
      throw Object.assign(new Error("Unknown test role"), { status: 403 });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 65536) throw new Error("Request too large");
    }
    const { name, input } = JSON.parse(body);
    const result = await as(role, () => {
      const ctx = mcpCtx.getStore();
      const permissions = [
        ...ctx.permissions,
        ...(["EMPLOYEE", "HR"].includes(role)
          ? [
              "hr.payroll.read",
              "hr.payroll.create",
              "hr.payroll.update",
              "hr.payroll.delete",
            ]
          : []),
      ];
      return mcpCtx.run(
        {
          ...ctx,
          permissions,
          user: { ...ctx.user, employeeId: String(people[role].id) },
        },
        async () => {
          if (approvalHandlers[name]) return approvalHandlers[name](input);
          const tool = handlers.get(name);
          if (!tool) throw new Error("Unknown tool " + name);
          const r = await tool.handler(tool.schema.parse(input));
          if (r.isError)
            throw Object.assign(
              new Error(r.content?.[0]?.text || "Tool failed"),
              { status: 409 },
            );
          const data = JSON.parse(r.content[0].text);
          return data?.success !== undefined && data?.data !== undefined
            ? data.data
            : data;
        },
      );
    });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = e.status || 500;
    res.end(JSON.stringify({ message: e.message, status: res.statusCode }));
  }
});
server.listen(5387, "127.0.0.1");
process.on("SIGTERM", () =>
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  }),
);
