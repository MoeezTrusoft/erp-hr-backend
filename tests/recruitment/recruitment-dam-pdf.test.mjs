import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { downloadRecruitmentPdf } from "../../src/lib/recruitmentDamPdf.js";

const tenant = "00000000-0000-4000-8000-000000000001";
const pdf = Buffer.from("%PDF-1.7\nfictional document\n%%EOF");
const env = {
  DAM_SERVICE_URL: "http://dam.internal",
  HR_DAM_DOWNLOAD_HOSTS: "storage.example.test",
};
const previous = {
  pem: process.env.SERVICE_JWT_PRIVATE_KEY_PEM,
  kid: process.env.SERVICE_JWT_CURRENT_KID,
};
test.before(() => {
  process.env.SERVICE_JWT_PRIVATE_KEY_PEM = generateKeyPairSync(
    "ed25519",
  ).privateKey.export({ type: "pkcs8", format: "pem" });
  process.env.SERVICE_JWT_CURRENT_KID = "test-only";
});
test.after(() => {
  for (const [key, value] of Object.entries({
    SERVICE_JWT_PRIVATE_KEY_PEM: previous.pem,
    SERVICE_JWT_CURRENT_KID: previous.kid,
  }))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
test("authenticates to DAM with the company claim, never to redirected storage", async () => {
  const calls = [];
  const result = await downloadRecruitmentPdf(tenant, 27, {
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), ...options });
      if (calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://storage.example.test/folder/offer.pdf?token=synthetic",
          },
        });
      if (calls.length === 2)
        return new Response(null, {
          status: 307,
          headers: { location: "signed.pdf?token=synthetic" },
        });
      return new Response(pdf);
    },
  });
  assert.deepEqual(result, pdf);
  const token = calls[0].headers["X-Service-Authorization"].slice(7);
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  assert.equal(claims.tid, tenant);
  assert.equal(claims.tenantId, tenant);
  assert.equal(calls[0].headers["X-Tenant-Id"], tenant);
  assert.ok(calls.every((c) => c.redirect === "manual"));
  assert.ok(calls.slice(1).every((c) => !c.headers));
  assert.equal(
    calls[2].url,
    "https://storage.example.test/folder/signed.pdf?token=synthetic",
  );
});
test("rejects unapproved, insecure and credential-bearing redirects before following", async () => {
  for (const location of [
    "https://attacker.example.test/a",
    "http://storage.example.test/a",
    "https://user:pass@storage.example.test/a",
  ]) {
    let calls = 0;
    await assert.rejects(
      downloadRecruitmentPdf(tenant, 27, {
        env,
        fetchImpl: async () => {
          calls++;
          return new Response(null, { status: 302, headers: { location } });
        },
      }),
      { code: "HR-5511" },
    );
    assert.equal(calls, 1);
  }
});
test("rejects loops, oversized bodies and non-PDF responses", async () => {
  let calls = 0;
  await assert.rejects(
    downloadRecruitmentPdf(tenant, 27, {
      env,
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://storage.example.test/loop" },
        });
      },
    }),
    { code: "HR-5511" },
  );
  assert.equal(calls, 3);
  for (const response of [
    new Response("error"),
    new Response(pdf, {
      headers: { "content-length": String(17 * 1024 * 1024) },
    }),
    new Response(Buffer.alloc(16 * 1024 * 1024 + 1)),
  ])
    await assert.rejects(
      downloadRecruitmentPdf(tenant, 27, {
        env,
        fetchImpl: async () => response,
      }),
      { code: "HR-5511" },
    );
});
test("rejects missing company identity and credentials before making a request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(pdf);
  };
  await assert.rejects(downloadRecruitmentPdf("", 27, { env, fetchImpl }), {
    code: "HR-5511",
  });
  delete process.env.SERVICE_JWT_CURRENT_KID;
  try {
    await assert.rejects(
      downloadRecruitmentPdf(tenant, 27, { env, fetchImpl }),
      { code: "HR-5511" },
    );
  } finally {
    process.env.SERVICE_JWT_CURRENT_KID = "test-only";
  }
  assert.equal(calls, 0);
});
