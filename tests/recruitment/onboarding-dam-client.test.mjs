import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createOnboardingDamClient,
  verifyOnboardingAsset,
  inspectOnboardingDocument,
  documentHash,
} from "../../src/lib/onboardingDamClient.js";
const tenantId = randomUUID(),
  checklistId = 42,
  bytes = Buffer.from("%PDF-1.7 synthetic onboarding test"),
  sha256 = documentHash(bytes),
  mimeType = "application/pdf";
const expected = {
  tenantId,
  checklistId,
  mediaId: 71,
  sha256,
  mimeType,
  byteSize: bytes.length,
};
const asset = {
  id: 71,
  tenantId,
  sha256,
  mimeType,
  size: bytes.length,
  accessStrategy: "INHERITED",
  parentType: "OTHER",
  parentId: "hr-onboarding:42",
  managedBy: "erp-hr",
  assetScan: { tenantId, status: "CLEAN" },
};
const env = {
  DAM_SERVICE_URL: "http://dam.internal/api",
  HR_DAM_DOWNLOAD_HOSTS: "storage.example.invalid",
};
const sign = () => "test-token";
test("rejects foreign, broadly accessible, wrong-parent and mutated assets", () => {
  assert.equal(verifyOnboardingAsset(asset, expected), asset);
  for (const patch of [
    { tenantId: randomUUID() },
    { parentId: "43" },
    { managedBy: "erp-comms" },
    { accessStrategy: "ROLE_BASED" },
    { sha256: "a".repeat(64) },
    { size: bytes.length + 1 },
    { assetScan: { tenantId: randomUUID(), status: "CLEAN" } },
    { assetScan: { tenantId, status: "INFECTED" } },
    { rightsStatus: "restricted" },
  ])
    assert.throws(() =>
      verifyOnboardingAsset({ ...asset, ...patch }, expected),
    );
});
test("scan-pending content cannot be downloaded as approved evidence", () => {
  assert.throws(
    () =>
      verifyOnboardingAsset(
        { ...asset, assetScan: { tenantId, status: "PENDING" } },
        expected,
      ),
    (e) => e.status === 409,
  );
  assert.equal(
    verifyOnboardingAsset(
      { ...asset, assetScan: { tenantId, status: "PENDING" } },
      expected,
      { clean: false },
    ).id,
    71,
  );
});
test("multipart uploads sign the checklist capability and send bytes only to trusted storage", async () => {
  let claims;
  const calls = [];
  const sessionId = randomUUID();
  const api = createOnboardingDamClient(
    { tenantId, checklistId },
    {
      env,
      sign: (c) => {
        claims = c;
        return sign();
      },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url === "http://dam.internal/v1/uploads")
          return Response.json({
            data: {
              sessionId,
              partSize: 10,
              parts: Array.from(
                { length: Math.ceil(bytes.length / 10) },
                (_, index) => ({
                  partNumber: index + 1,
                  url: "https://storage.example.invalid/part/" + (index + 1),
                }),
              ),
            },
          });
        if (options.method === "PUT")
          return new Response(null, { headers: { etag: '"part-etag"' } });
        return Response.json({ data: { asset: { id: 71 } } });
      },
    },
  );
  assert.equal(
    await api.upload({
      bytes,
      mimeType,
      externalId: "onboarding:stable-request",
    }),
    71,
  );
  assert.equal(claims.parentType, "OTHER");
  assert.equal(claims.parentId, "hr-onboarding:42");
  assert.equal(claims.tid, tenantId);
  assert.equal(claims.capabilityVerified, true);
  assert.ok(Date.parse(claims.capabilityExpiresAt) - Date.now() <= 60000);
  const uploaded = calls.filter((c) => c.options.method === "PUT");
  assert.deepEqual(Buffer.concat(uploaded.map((c) => c.options.body)), bytes);
  for (const call of uploaded) {
    assert.equal(call.options.headers, undefined);
    assert.equal(call.options.redirect, "manual");
  }
  const init = JSON.parse(calls[0].options.body);
  assert.equal(init.sha256, sha256);
  assert.equal(init.accessStrategy, "INHERITED");
  assert.equal(init.size, bytes.length);
  const complete = calls.at(-1);
  assert.equal(
    complete.url,
    "http://dam.internal/v1/uploads/" + sessionId + "/complete",
  );
  assert.equal(
    complete.options.headers["Idempotency-Key"],
    "onboarding:stable-request",
  );
  assert.equal(JSON.parse(complete.options.body).etags.length, uploaded.length);
});
test("unsafe upload URLs fail before content transfer and abort only the uncompleted session", async () => {
  for (const location of [
    "http://storage.example.invalid/a",
    "https://attacker.invalid/a",
    "https://user:secret@storage.example.invalid/a",
  ]) {
    const calls = [];
    const sessionId = randomUUID();
    const api = createOnboardingDamClient(
      { tenantId, checklistId },
      {
        env,
        sign,
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          return Response.json({
            data: {
              sessionId,
              partSize: bytes.length,
              parts: [{ partNumber: 1, url: location }],
            },
          });
        },
      },
    );
    await assert.rejects(
      api.upload({ bytes, mimeType, externalId: "request" }),
      (e) => e.status === 503,
    );
    assert.equal(
      calls.some((c) => c.options.method === "PUT"),
      false,
    );
    assert.equal(calls.at(-1).options.method, "DELETE");
  }
});
test("completion timeouts preserve uncertain uploads for content-hash reconciliation", async () => {
  const calls = [];
  const sessionId = randomUUID();
  const api = createOnboardingDamClient(
    { tenantId, checklistId },
    {
      env,
      sign,
      fetchImpl: async (url, options) => {
        calls.push(options.method);
        if (url.endsWith("/complete")) throw Error("timeout after commit");
        if (options.method === "PUT")
          return new Response(null, { headers: { etag: '"ok"' } });
        return Response.json({
          data: {
            sessionId,
            partSize: bytes.length,
            parts: [
              { partNumber: 1, url: "https://storage.example.invalid/part" },
            ],
          },
        });
      },
    },
  );
  await assert.rejects(
    api.upload({ bytes, mimeType, externalId: "request" }),
    (e) => e.status === 503,
  );
  assert.equal(calls.includes("DELETE"), false);
});
test("private downloads authenticate DAM and never forward the token to storage", async () => {
  const calls = [];
  const api = createOnboardingDamClient(
    { tenantId, checklistId },
    {
      env,
      sign,
      fetchImpl: async (url, o) => {
        calls.push({ url: String(url), o });
        return calls.length === 1
          ? Response.json({
              data: {
                ...asset,
                url: "https://storage.example.invalid/private.pdf",
              },
            })
          : new Response(bytes);
      },
    },
  );
  assert.deepEqual(await api.download(71, { sha256, mimeType }), bytes);
  assert.equal(
    calls[0].o.headers["X-Service-Authorization"],
    "Bearer test-token",
  );
  assert.equal(calls[1].o.headers, undefined);
});
test("rejects unsafe redirects and changed bytes", async () => {
  for (const location of [
    "https://untrusted.invalid/doc",
    "http://storage.example.invalid/doc",
    "https://user:password@storage.example.invalid/doc",
  ]) {
    let count = 0;
    const api = createOnboardingDamClient(
      { tenantId, checklistId },
      {
        env,
        sign,
        fetchImpl: async () => {
          count++;
          if (count === 1)
            return Response.json({
              data: {
                ...asset,
                url: "https://storage.example.invalid/private.pdf",
              },
            });
          return new Response(null, { status: 302, headers: { location } });
        },
      },
    );
    await assert.rejects(
      api.download(71, { sha256, mimeType }),
      (e) => e.status === 503,
    );
    assert.equal(count, 2);
  }
  const api = createOnboardingDamClient(
    { tenantId, checklistId },
    {
      env,
      sign,
      fetchImpl: async (url) =>
        String(url).startsWith("http://dam.internal/")
          ? Response.json({
              data: {
                ...asset,
                url: "https://storage.example.invalid/private.pdf",
              },
            })
          : new Response(Buffer.from("%PDF-modified")),
    },
  );
  await assert.rejects(
    api.download(71, { sha256, mimeType }),
    (e) => e.status === 409,
  );
});
test("bounds file size and refuses non-document content and absent credentials before I/O", async () => {
  assert.equal(inspectOnboardingDocument(bytes), mimeType);
  assert.throws(() =>
    inspectOnboardingDocument(Buffer.from("<html>bad</html>")),
  );
  assert.throws(() =>
    inspectOnboardingDocument(Buffer.alloc(5 * 1024 * 1024 + 1)),
  );
  let called = false;
  const api = createOnboardingDamClient(
    { tenantId, checklistId },
    {
      env,
      sign: () => null,
      fetchImpl: async () => {
        called = true;
      },
    },
  );
  await assert.rejects(api.metadata(71), (e) => e.status === 503);
  assert.equal(called, false);
});

test("download rejects mismatched metadata before contacting object storage", async () => {
  for (const patch of [
    { tenantId: randomUUID() },
    { parentId: "hr-onboarding:43" },
    { accessStrategy: "ROLE_BASED" },
    { assetScan: { tenantId, status: "PENDING_SCAN" } },
    { url: "https://untrusted.invalid/file.pdf" },
  ]) {
    let calls = 0;
    const api = createOnboardingDamClient(
      { tenantId, checklistId },
      {
        env,
        sign,
        fetchImpl: async () => {
          calls++;
          return Response.json({
            data: {
              ...asset,
              url: "https://storage.example.invalid/private.pdf",
              ...patch,
            },
          });
        },
      },
    );
    await assert.rejects(api.download(71, { sha256, mimeType }));
    assert.equal(calls, 1);
  }
});
