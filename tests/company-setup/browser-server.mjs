// Test transport only. All writes target a disposable loopback database.
import http from "node:http";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { samplePolicy } from "./policy.mjs";
const url = process.env.ASSESSMENT_TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).pathname !== "/hr_task_assessment_test"
)
  throw new Error("Isolated HR test database required");
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = url;
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
const keys = generateKeyPairSync("ed25519");
process.env.SERVICE_JWT_PRIVATE_KEY_PEM = keys.privateKey.export({
  type: "pkcs8",
  format: "pem",
});
process.env.SERVICE_JWT_CURRENT_KID = "setup-browser";
let accounts = [];
const peer = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const rpc = JSON.parse(body);
  let value = { accounts, departments: ["HR"] };
  if (rpc.params.name === "rbac_hr_setup_identity_apply") {
    const p = JSON.parse(
      Buffer.from(rpc.params.arguments.proof.split(".")[1], "base64url"),
    ).plan;
    const a = accounts.find((a) => a.userId === p.userId);
    if (p.action === "REMOVE_COMPANY_ACCESS")
      accounts = accounts.filter((x) => x !== a);
    else
      Object.assign(a, {
        employeeCode: p.employeeCode,
        hrEmployeeId: p.hrEmployeeId,
      });
    value = { applied: true, reviewRef: p.reviewRef, digest: p.digest };
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: JSON.stringify(value) }] },
    }),
  );
});
await new Promise((r) => peer.listen(0, "127.0.0.1", r));
process.env.RBAC_SERVICE_URL = `http://127.0.0.1:${peer.address().port}`;
const { default: prisma } = await import("../../src/lib/prisma.js"),
  { mcpCtx } = await import("../../src/mcp/context.js"),
  { tenantTransaction } = await import("../../src/lib/rlsTenant.js"),
  { setupHandlers } = await import("../../src/mcp/tools/companySetupTools.js");
const company = randomUUID(),
  people = {},
  grants = {
    HR: ["read", "prepare", "activate"],
    CEO: ["read", "approve"],
    EMP: [],
    ADMIN: [],
  };
const db = (fn) =>
  mcpCtx.run({ user: { tenantId: company } }, () =>
    tenantTransaction(prisma, fn, { tenantId: company }),
  );
await db(async (tx) => {
  const g = await tx.gradeLevel.create({
    data: { tenantId: company, name: "G1" },
  });
  let i = 0;
  for (const role of Object.keys(grants)) {
    people[role] = await tx.employee.create({
      data: {
        tenant_id: company,
        employee_code: (role === "CEO" ? "MGMT-" : "EMP-") + (9801 + i++),
        employeeCategory: role === "CEO" ? "MANAGEMENT" : "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
        gradeLevelId: g.id,
        contractNoticeDays: role === "EMP" ? null : 30,
        userId: 100000 + Math.floor(Math.random() * 1e8),
      },
    });
  }
  for (const role of Object.keys(people).filter((r) => r !== "CEO"))
    await tx.employee.update({
      where: { id: people[role].id },
      data: { managerId: people.CEO.id },
    });
});
accounts = Object.values(people).map((e) => ({
  userId: e.userId,
  login: e.employee_code.toLowerCase() + "@example.test",
  member: true,
  enabled: true,
  employeeCode: e.employee_code,
  hrEmployeeId: e.id,
  fingerprint: "a".repeat(64),
  permissions: [
    "hr.setup.approve",
    "hr.separation.verify",
    "hr.separation.approve",
    "hr.separation.task",
  ],
}));
accounts.push({
  userId: 900000001,
  login: "duplicate@example.test",
  member: true,
  enabled: true,
  employeeCode: null,
  hrEmployeeId: people.EMP.id,
  fingerprint: "b".repeat(64),
  permissions: [],
});
const as = (role, fn) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: company,
        userId: people[role].userId,
        isAdmin: role === "ADMIN",
      },
      permissions: grants[role].map((p) => "hr.setup." + p),
    },
    fn,
  );
const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  try {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/health") {
      res.end("{}");
      return;
    }
    if (path === "/fixture") {
      res.end(
        JSON.stringify({
          employeeCode: people.EMP.employee_code,
          hrCode: people.HR.employee_code,
          managerCode: people.CEO.employee_code,
          policy: samplePolicy(
            people.HR.employee_code,
            people.CEO.employee_code,
          ),
        }),
      );
      return;
    }
    if (path !== "/rpc" || req.method !== "POST") {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    const role = req.headers["x-test-role"];
    if (!grants[role])
      throw Object.assign(new Error("Unknown test actor"), { status: 403 });
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 100000) throw new Error("Too large");
    }
    const { name, input } = JSON.parse(body);
    if (!setupHandlers[name]) throw new Error("Unknown test tool");
    res.end(JSON.stringify(await as(role, () => setupHandlers[name](input))));
  } catch (e) {
    res.statusCode = e.status || 500;
    res.end(JSON.stringify({ message: e.message }));
  }
});
server.listen(5387, "127.0.0.1");
process.on("SIGTERM", () =>
  server.close(async () => {
    peer.close();
    await prisma.$disconnect();
    process.exit(0);
  }),
);
