import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
process.env.SERVICE_JWT_PRIVATE_KEY_PEM = privateKey.export({
  type: "pkcs8",
  format: "pem",
});
process.env.SERVICE_JWT_CURRENT_KID = "test-recruitment";
process.env.INTERNAL_SERVICE_SECRET = "test-only-internal-secret";
const received = [];
let status = 202;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  received.push({ headers: req.headers, body: JSON.parse(body) });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      notificationId: "test-notification",
      results: [{ channel: "email", status: "queued" }],
    }),
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
process.env.NOTIFICATION_HUB_URL = "http://127.0.0.1:" + server.address().port;
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { sendCandidateNotification } =
  await import("../../src/lib/notificationClient.js");
const tenantId = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const send = () =>
  mcpCtx.run({ user: { tenantId } }, () =>
    sendCandidateNotification({
      tenantId,
      email: "fictional@example.invalid",
      templateId: "hr.recruitment.candidate.portal_status_link",
      data: { statusUrl: "https://careers.example.invalid/status" },
      dedupeKey: "test-message",
      category: "hr.recruitment.candidate",
    }),
  );
test("notification HTTP carries authenticated tenant headers and stable dedupe key", async () => {
  const result = await send();
  assert.equal(result.sent, true);
  const { headers, body } = received[0];
  assert.equal(headers["x-internal-secret"], "test-only-internal-secret");
  assert.equal(headers["x-tenant-id"], tenantId);
  const parts = headers["x-service-authorization"]
    .replace(/^Bearer /, "")
    .split(".");
  assert.equal(parts.length, 3);
  assert.ok(
    verify(
      null,
      Buffer.from(parts[0] + "." + parts[1]),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    ),
  );
  assert.equal(
    JSON.parse(Buffer.from(parts[1], "base64url").toString()).tid,
    tenantId,
  );
  assert.equal(body.dedupeKey, "test-message");
  assert.deepEqual(body.recipients, [{ email: "fictional@example.invalid" }]);
});
test("unavailable Hub returns retryable result", async () => {
  status = 503;
  assert.equal((await send()).sent, false);
});
test.after(async () => {
  server.close();
  await once(server, "close");
});
