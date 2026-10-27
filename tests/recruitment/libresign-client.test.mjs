import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import {
  createLibreSignClient,
  configuredLibreSign,
} from "../../src/lib/libresignClient.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const fileUuid = "00000000-0000-4000-8000-000000000002";
const signUuid = "00000000-0000-4000-8000-000000000003";
const pdf = Buffer.from("%PDF-1.7\nSynthetic offer test\n%%EOF");
const sha256 = createHash("sha256").update(pdf).digest("hex");
const identity = { offerId: 21, version: 2, sha256 };
const expected = {
  name: "offer-21-v2-" + sha256,
  nodeId: 25,
  email: "candidate@example.test",
};
const row = (patch = {}) => ({
  id: 30,
  uuid: fileUuid,
  nodeId: 25,
  name: expected.name,
  status: 1,
  signers: [
    {
      signRequestId: 31,
      identifyMethods: [{ method: "email", value: expected.email }],
      signed: null,
      status: 1,
      sign_request_uuid: signUuid,
    },
  ],
  ...patch,
});
const ok = (data) =>
  new Response(
    JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200 }, data } }),
  );
const client = (handler, config = {}) =>
  createLibreSignClient({
    tenantId,
    baseUrl: "https://sign.example.test",
    username: "recruitment-service",
    appPassword: "test-app-password",
    fetchImpl: handler,
    ...config,
  });

test("rejects insecure, credential-bearing and malformed provider configuration", () => {
  for (const baseUrl of [
    "http://sign.example.test",
    "https://user:password@sign.example.test",
    "https://sign.example.test/?x=1",
    "file:///etc/passwd",
  ])
    assert.throws(() => client(() => {}, { baseUrl }), { code: "HR-5510" });
  assert.throws(() => client(() => {}, { username: "../../someone" }));
  assert.doesNotThrow(() =>
    client(() => {}, {
      baseUrl: "http://127.0.0.1:5398",
      allowLocalHttp: true,
    }),
  );
});

test("prepares one checksum-bound PDF using conditional DAV writes", async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === "MKCOL") return new Response(null, { status: 201 });
    if (options.method === "PUT") return new Response(null, { status: 201 });
    return new Response(
      '<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><oc:fileid>25</oc:fileid></d:multistatus>',
      { status: 207 },
    );
  });
  const prepared = await c.prepareDocument(identity, pdf);
  assert.equal(prepared.nodeId, 25);
  assert.match(prepared.path, new RegExp(tenantId + "/offer-21-v2-" + sha256));
  assert.equal(
    calls.find((r) => r.method === "PUT").headers["If-None-Match"],
    "*",
  );
  assert.ok(calls.every((r) => r.redirect === "manual"));
  assert.ok(calls.every((r) => r.headers["OCS-APIRequest"] === "true"));
});

test("rejects a PDF whose digest differs before sending bytes", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
  });
  await assert.rejects(
    c.prepareDocument(identity, Buffer.from("%PDF-different")),
    { reason: "DOCUMENT" },
  );
  assert.equal(calls, 0);
});

test("a repeated upload verifies existing content and cannot overwrite it", async () => {
  let props = false;
  const c = client(async (_url, options) => {
    if (options.method === "MKCOL") return new Response(null, { status: 405 });
    if (options.method === "PUT") return new Response(null, { status: 412 });
    if (options.method === "GET") return new Response("%PDF-tampered");
    props = true;
    return new Response("", { status: 207 });
  });
  await assert.rejects(c.prepareDocument(identity, pdf), {
    reason: "DOCUMENT",
  });
  assert.equal(props, false);
});

test("creation uses the prepared node and sends the private provider invitation", async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push({ url, ...options });
    return options.method === "GET" ? ok({ data: [] }) : ok(row());
  });
  const result = await c.requestSignature(expected);
  const sent = JSON.parse(calls[1].body);
  assert.deepEqual(sent.file, { nodeId: 25 });
  assert.equal(sent.signers[0].notify, 1);
  assert.equal(result.fileUuid, fileUuid);
  assert.equal(
    result.signingUrl,
    "https://sign.example.test/index.php/apps/libresign/p/sign/" + signUuid,
  );
});

test("reconciliation recovers the existing workflow without another POST", async () => {
  const calls = [];
  const c = client(async (_url, options) => {
    calls.push(options.method);
    return ok({ data: [row()] });
  });
  assert.equal((await c.requestSignature(expected)).fileId, 30);
  assert.deepEqual(calls, ["GET"]);
});

test("unknown creation outcome is marked uncertain and never blindly retried", async () => {
  let posts = 0;
  const c = client(async (_url, options) => {
    if (options.method === "GET") return ok({ data: [] });
    posts++;
    throw new Error("secret detail must not escape");
  });
  await assert.rejects(
    c.requestSignature(expected),
    (error) => error.uncertain && !error.message.includes("secret"),
  );
  assert.equal(await c.reconcile(expected), null);
  assert.equal(posts, 1);
});

test("OCS errors inside HTTP 200 are not successful signature requests", async () => {
  const c = client(async (_url, options) =>
    options.method === "GET"
      ? ok({ data: [] })
      : new Response(
          JSON.stringify({
            ocs: { meta: { status: "failure", statuscode: 401 }, data: {} },
          }),
        ),
  );
  await assert.rejects(c.requestSignature(expected), {
    code: "HR-5510",
    uncertain: true,
  });
});

test("redirects cannot forward the provider credential", async () => {
  let redirects;
  const c = client(async (_url, options) => {
    redirects = options.redirect;
    return new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example/" },
    });
  });
  await assert.rejects(c.reconcile(expected), { code: "HR-5510" });
  assert.equal(redirects, "manual");
});

test("rejects a foreign node, changed document, wrong signer and duplicate workflows", async () => {
  for (const rows of [
    [row({ nodeId: 26 })],
    [row({ name: "other" })],
    [row({ signers: [{ signRequestId: 31, email: "another@example.test" }] })],
    [row(), row({ id: 32 })],
  ]) {
    await assert.rejects(
      client(async () => ok({ data: rows })).reconcile(expected),
      { code: "HR-5510" },
    );
  }
  await assert.rejects(
    client(async () => ok({ data: [row()] })).reconcile({
      ...expected,
      fileId: 99,
      fileUuid,
    }),
    { reason: "IDENTITY" },
  );
});

test("unsigned and partial workflows cannot supply a signed offer", async () => {
  for (const status of [0, 1, 2, 5]) {
    let calls = 0;
    const c = client(async () => {
      calls++;
      return ok({ data: [row({ status })] });
    });
    await assert.rejects(c.downloadSigned(expected), { reason: "INCOMPLETE" });
    assert.equal(calls, 1);
  }
});

test("signed download requires the matching signer and returns a new PDF checksum", async () => {
  const signed = row({
    status: 3,
    signers: [
      { ...row().signers[0], status: 2, signed: "2026-10-21T00:00:00Z" },
    ],
  });
  const c = client(async (url) =>
    url.includes("/file/list") ? ok({ data: [signed] }) : new Response(pdf),
  );
  const output = await c.downloadSigned({ ...expected, fileId: 30, fileUuid });
  assert.equal(output.sha256, sha256);
  assert.equal(output.workflow.signedAt, "2026-10-21T00:00:00Z");
  await assert.rejects(
    client(async () => ok({ data: [row({ status: 3 })] })).downloadSigned(
      expected,
    ),
    { reason: "INCOMPLETE" },
  );
});

test("cancellation verifies file ownership, keeps the source PDF and handles a prior cancellation", async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push({ url, ...options });
    return options.method === "GET"
      ? ok({ data: [row()] })
      : ok({ message: "Success" });
  });
  await c.cancel({ ...expected, fileId: 30, fileUuid });
  assert.match(calls[1].url, /file\/file_id\/30\?deleteFile=false$/);
  assert.equal(calls[1].method, "DELETE");
  const empty = client(async () => ok({ data: [] }));
  assert.deepEqual(await empty.cancel(expected), { cancelled: true });
});

test("bounded responses reject large upstream data", async () => {
  const c = client(
    async () =>
      new Response("{}", { headers: { "content-length": "2000000" } }),
  );
  await assert.rejects(c.reconcile(expected), { code: "HR-5510" });
});

test("tenant configuration requires distinct provider accounts and blocks local HTTP in production", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recruitment-libresign-"));
  try {
    const secret = join(dir, "app-password");
    const configFile = join(dir, "tenants.json");
    await writeFile(secret, "test-only-password");
    const binding = {
      baseUrl: "http://127.0.0.1:5398",
      username: "erp-recruitment",
      appPasswordFile: secret,
    };
    await writeFile(configFile, JSON.stringify({ [tenantId]: binding }));
    const env = {
      HR_LIBRESIGN_CONFIG_FILE: configFile,
      HR_LIBRESIGN_ALLOW_LOCAL_HTTP: "true",
      NODE_ENV: "production",
    };
    await assert.rejects(configuredLibreSign(tenantId, { env }), {
      reason: "CONFIGURATION",
    });
    env.NODE_ENV = "test";
    assert.ok(await configuredLibreSign(tenantId, { env }));
    await assert.rejects(configuredLibreSign(fileUuid, { env }), {
      reason: "CONFIGURATION",
    });
    await writeFile(
      configFile,
      JSON.stringify({ [tenantId]: binding, [fileUuid]: binding }),
    );
    await assert.rejects(
      configuredLibreSign(tenantId, { env }),
      /separate LibreSign account/,
    );
    await writeFile(
      configFile,
      JSON.stringify({
        [tenantId]: { ...binding, baseUrl: "https://SIGN.example.test:443/" },
        [fileUuid]: {
          ...binding,
          baseUrl: "https://sign.example.test",
          username: "ERP-RECRUITMENT",
        },
      }),
    );
    await assert.rejects(
      configuredLibreSign(tenantId, { env }),
      /separate LibreSign account/,
    );
    await writeFile(
      configFile,
      JSON.stringify({
        [tenantId]: binding,
        [fileUuid]: { ...binding, username: "company-two" },
      }),
    );
    assert.ok(await configuredLibreSign(tenantId, { env }));
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("recruitment-libresign-"));
    await rm(dir, { recursive: true, force: true });
  }
});

test("recognizes asynchronous signing and the provider cancellation caused by signer rejection", async () => {
  const pending = await client(async () =>
    ok({ data: [row({ status: 5 })] }),
  ).reconcile(expected);
  assert.equal(pending.declined, false);
  const declined = await client(async () =>
    ok({
      data: [row({ status: 6, signers: [{ ...row().signers[0], status: 3 }] })],
    }),
  ).reconcile(expected);
  assert.equal(declined.declined, true);
});

test('onboarding documents use a separate tenant folder and closed document identities',async()=>{
 const calls=[];const api=client(async(url,options)=>{calls.push({url,...options});if(['MKCOL','PUT'].includes(options.method))return new Response(null,{status:201});return new Response('<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><oc:fileid>25</oc:fileid></d:multistatus>',{status:207});});
 const result=await api.prepareDocument({kind:'onboarding',documentId:31,version:1,sha256},pdf);
 assert.equal(result.name,'onboarding-31-v1-'+sha256);assert.ok(result.path.includes('/OnboardingDocuments/'+tenantId+'/'));assert.ok(!calls.some(c=>c.url.includes('RecruitmentOffers')));
 await assert.rejects(api.prepareDocument({kind:'../../foreign',documentId:31,offerId:21,version:1,sha256},pdf),{reason:'DOCUMENT'});
});
