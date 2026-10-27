import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt, randomBytes } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_ONBOARDING_AUTOMATION = "on";
process.env.HR_RECRUITMENT_LIBRESIGN = "on";
process.env.HR_C4_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { documentHash } = await import("../../src/lib/onboardingDamClient.js");
const {
  uploadOnboardingDocument: upload,
  listOnboardingDocuments: list,
  downloadOnboardingDocument: download,
  reviewOnboardingDocument: review,
  runOnboardingUploads: scan,
  requireOnboardingSignatures,
} = await import("../../src/services/onboardingDocuments.service.js");
const {
  requestOnboardingSignature: request,
  cancelOnboardingSignature: cancel,
  openOnboardingSignature: open,
  runOnboardingSignatures: sign,
} = await import("../../src/services/onboardingSignatures.service.js");
const tenant = randomUUID(),
  foreign = randomUUID(),
  people = {};
let c,
  foreignC,
  doc,
  sig,
  clock = new Date(Date.now() + 1000);
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, { tenantId: t }),
  );
const permissions = {
  hr: ["hr.onboarding.read", "hr.onboarding.create", "hr.onboarding.update"],
  self: ["hr.self.read"],
  other: ["hr.self.read"],
  manager: ["hr.onboarding.read", "hr.onboarding.update"],
  reader: ["hr.onboarding.read"],
};
const as = (who, fn, extra = {}) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: tenant,
        userId: people[who].userId,
        employeeId: people.hr.id,
        roles: [
          who === "hr" || who === "reader"
            ? "HR_ADMIN"
            : who === "manager"
              ? "MANAGER"
              : "EMPLOYEE",
        ],
      },
      permissions: permissions[who],
      ...extra,
    },
    fn,
  );
const system = (fn) => mcpCtx.run({ system: true }, fn);
const rejects = (p, status) =>
  assert.rejects(p, (e) => (e.statusCode ?? e.status) === status);
const assets = new Map();
let uploads = 0,
  nextId = 100,
  scanState = "CLEAN",
  timeoutAfterUpload = false;
const damFactory = ({ tenantId, checklistId }) => ({
  async upload({ bytes, mimeType }) {
    uploads++;
    let row = [...assets.values()].find(
      (a) =>
        a.tenantId === tenantId &&
        a.parentId === "hr-onboarding:" + checklistId &&
        a.sha256 === documentHash(bytes),
    );
    if (!row) {
      row = {
        id: ++nextId,
        tenantId,
        parentType: "OTHER",
        parentId: "hr-onboarding:" + checklistId,
        managedBy: "erp-hr",
        accessStrategy: "INHERITED",
        sha256: documentHash(bytes),
        mimeType,
        size: bytes.length,
        bytes,
        assetScan: { tenantId, status: scanState },
      };
      assets.set(row.id, row);
    }
    if (timeoutAfterUpload) {
      timeoutAfterUpload = false;
      throw Object.assign(Error("timeout"), { status: 503 });
    }
    return row.id;
  },
  async metadata(id) {
    return structuredClone(assets.get(id));
  },
  async download(id) {
    return assets.get(id).bytes;
  },
});
const options = { damFactory };
const pdf = (n) => Buffer.from("%PDF-1.7\n synthetic document " + n);
const input = (n, extra = {}) => ({
  checklistId: c.id,
  title: "Document " + n,
  requestKey: randomUUID(),
  contentBase64: pdf(n).toString("base64"),
  ...extra,
});
const byId = async (id) =>
  (await as("self", () => list({}, tenant))).documents.find((d) => d.id === id);
let sends = 0,
  prepared = 0,
  uncertain = false,
  workflow = null,
  observedState;
const signedBytes = pdf("signed");
const api = {
  async prepareDocument(document, bytes) {
    assert.equal(document.kind, "onboarding");
    assert.equal(document.sha256, documentHash(bytes));
    prepared++;
    return { nodeId: 555 };
  },
  async requestSignature(expected) {
    sends++;
    observedState = (
      await tx((t) =>
        t.$queryRawUnsafe(
          'SELECT state FROM "OnboardingDocumentSignature" WHERE "tenantId"=$1::uuid AND "documentId"=$2',
          tenant,
          doc.documentId,
        ),
      )
    )[0].state;
    assert.equal(expected.email, "employee@example.test");
    workflow = {
      fileId: 77,
      fileUuid: randomUUID(),
      status: 1,
      signingUrl: "https://sign.example.test/invitation/" + randomUUID(),
    };
    if (uncertain) {
      uncertain = false;
      throw Object.assign(Error("timeout"), { status: 503, uncertain: true });
    }
    return workflow;
  },
  async reconcile() {
    return workflow;
  },
  async cancel() {
    workflow = null;
    return { cancelled: true };
  },
  async downloadSigned() {
    return { bytes: signedBytes, sha256: documentHash(signedBytes), workflow };
  },
};
const client = async () => api;
const step = () => {
  clock = new Date(+clock + 480000);
  return system(() =>
    sign({ tenantId: tenant, now: clock, client, damFactory }),
  );
};
test.before(async () => {
  await tx(async (t) => {
    for (const name of Object.keys(permissions))
      people[name] = await t.employee.create({
        data: {
          tenant_id: tenant,
          employee_code: "OD-" + randomUUID().toUpperCase(),
          employeeCategory: "EMPLOYEE",
          first_name: name,
          userId: randomInt(10000, 1000000000),
          status: "Active",
          email:
            name === "self" ? "employee@example.test" : name + "@example.test",
        },
      });
    c = await t.onboardingChecklist.create({
      data: {
        tenantId: tenant,
        employeeId: people.self.id,
        startDate: new Date("2031-01-01"),
      },
    });
  });
  await tx(async (t) => {
    const p = await t.employee.create({
      data: {
        tenant_id: foreign,
        employee_code: "OD-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
      },
    });
    foreignC = await t.onboardingChecklist.create({
      data: {
        tenantId: foreign,
        employeeId: p.id,
        startDate: new Date("2031-01-01"),
      },
    });
  }, foreign);
});
test("owned uploads reject foreign rows, forged actors, malformed bytes and employee signature requests", async () => {
  await rejects(
    as("other", () => upload(input(1), tenant, options)),
    404,
  );
  await rejects(
    as("self", () =>
      upload(input(1, { checklistId: foreignC.id }), tenant, options),
    ),
    404,
  );
  await rejects(
    as("manager", () => upload(input(1), tenant, options)),
    403,
  );
  await rejects(
    as("self", () => upload(input(1), tenant, options), {
      actorVerified: false,
    }),
    401,
  );
  await rejects(
    as("self", () => upload(input(1, { requiresSign: true }), tenant, options)),
    403,
  );
  await rejects(
    as("self", () =>
      upload(input(1, { contentBase64: "bad" }), tenant, options),
    ),
    422,
  );
  assert.equal(uploads, 0);
});
test("concurrent replay creates one private document, returns no URL, and binds input bytes to request key", async () => {
  const args = input(2);
  await Promise.all([
    as("self", () => upload(args, tenant, options)),
    as("self", () => upload(args, tenant, options)),
  ]);
  assert.equal(uploads, 1);
  const result = await as("self", () => list({}, tenant));
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].reviewState, "PENDING");
  assert.equal(result.documents[0].canReview, false);
  assert.equal(result.documents[0].mediaId, undefined);
  assert.ok(!JSON.stringify(result).includes("http"));
  await rejects(
    as("self", () => upload({ ...args, title: "Different" }, tenant, options)),
    409,
  );
  await rejects(
    as("self", () =>
      upload(
        { ...args, contentBase64: pdf("different").toString("base64") },
        tenant,
        options,
      ),
    ),
    409,
  );
  const saved = await as("self", () => upload(args, tenant, options));
  assert.equal(saved.state, "READY");
  assert.equal(uploads, 1);
  assert.equal(
    (await as("reader", () => list({ checklistId: c.id }, tenant))).canUpload,
    false,
  );
});
test("uncertain storage replays resolve the same private asset and one employee document", async () => {
  const args = input(3);
  timeoutAfterUpload = true;
  await rejects(
    as("self", () => upload(args, tenant, options)),
    503,
  );
  const r = await as("self", () => upload(args, tenant, options));
  assert.equal(r.state, "READY");
  assert.equal((await as("self", () => list({}, tenant))).documents.length, 2);
  assert.equal(assets.size, 2);
});
test("malware scan gates admission, scheduler recovers clean documents and rejects malicious content", async () => {
  scanState = "PENDING";
  const waiting = await as("self", () => upload(input(4), tenant, options));
  assert.equal(waiting.state, "SCANNING");
  assert.equal(waiting.documentId, null);
  const asset = [...assets.values()].at(-1);
  asset.assetScan.status = "CLEAN";
  assert.equal(
    (await system(() => scan({ tenantId: tenant, damFactory }))).ready,
    1,
  );
  assert.equal((await as("self", () => list({}, tenant))).documents.length, 3);
  scanState = "INFECTED";
  await rejects(
    as("self", () => upload(input(5), tenant, options)),
    422,
  );
  assert.equal(
    (await as("self", () => list({}, tenant))).uploads[0].state,
    "REJECTED",
  );
  scanState = "CLEAN";
  await rejects(
    as("hr", () => scan({ tenantId: tenant, damFactory })),
    403,
  );
});
test("reviews need HR permission and exact evidence; changes are versioned and encrypted", async () => {
  doc = await as("hr", () =>
    upload(input(6, { requiresSign: true }), tenant, options),
  );
  await rejects(
    as("self", () =>
      review(
        {
          documentId: doc.documentId,
          expectedVersion: 0,
          reviewState: "VERIFIED",
        },
        tenant,
        options,
      ),
    ),
    403,
  );
  const saved = await as("hr", () =>
    review(
      {
        documentId: doc.documentId,
        expectedVersion: 0,
        reviewState: "VERIFIED",
        note: "c4.v1: Verified against original",
      },
      tenant,
      options,
    ),
  );
  assert.equal(saved.version, 1);
  await rejects(
    as("hr", () =>
      review(
        {
          documentId: doc.documentId,
          expectedVersion: 0,
          reviewState: "REJECTED",
          note: "No",
        },
        tenant,
        options,
      ),
    ),
    412,
  );
  const [raw] = await tx((t) =>
    t.$queryRawUnsafe(
      'SELECT * FROM "OnboardingDocumentEvidence" WHERE "documentId"=$1',
      doc.documentId,
    ),
  );
  assert.match(raw.reviewNoteCipher, /^c4\.v1:/);
  assert.ok(!raw.reviewNoteCipher.includes("Verified against"));
  assert.equal(
    (await byId(doc.documentId)).reviewNote,
    "c4.v1: Verified against original",
  );
});
test("private downloads recheck company ownership, parent policy, scan and current digest", async () => {
  const args = { documentId: doc.documentId };
  assert.equal(
    (await as("self", () => download(args, tenant, options))).contentBase64,
    pdf(6).toString("base64"),
  );
  await rejects(
    as("other", () => download(args, tenant, options)),
    404,
  );
  await rejects(
    as("manager", () => download(args, tenant, options)),
    403,
  );
  const asset = [...assets.values()].at(-1),
    hash = asset.sha256;
  asset.sha256 = "0".repeat(64);
  await rejects(
    as("self", () => download(args, tenant, options)),
    409,
  );
  asset.sha256 = hash;
  asset.assetScan.status = "PENDING";
  await rejects(
    as("hr", () => download(args, tenant, options)),
    409,
  );
  asset.assetScan.status = "CLEAN";
  asset.parentId = "hr-onboarding:" + foreignC.id;
  await rejects(
    as("self", () => download(args, tenant, options)),
    409,
  );
  asset.parentId = "hr-onboarding:" + c.id;
});
test("signature request requires confirmed current mailbox, flags and one immutable reviewed PDF", async () => {
  const args = {
    documentId: doc.documentId,
    expectedVersion: 1,
    confirmedEmail: "employee@example.test",
    recipientConfirmed: true,
  };
  await rejects(
    as("hr", () =>
      request({ ...args, confirmedEmail: "other@example.test" }, tenant, {
        client,
        damFactory,
      }),
    ),
    422,
  );
  await rejects(
    as("hr", () =>
      request({ ...args, recipientConfirmed: false }, tenant, {
        client,
        damFactory,
      }),
    ),
    422,
  );
  process.env.HR_RECRUITMENT_LIBRESIGN = "off";
  await rejects(
    as("hr", () => request(args, tenant, { client, damFactory })),
    503,
  );
  process.env.HR_RECRUITMENT_LIBRESIGN = "on";
  const results = await Promise.all([
    as("hr", () => request(args, tenant, { client, damFactory })),
    as("hr", () => request(args, tenant, { client, damFactory })),
  ]);
  sig = results[0];
  assert.equal(results[0].id, results[1].id);
  assert.equal(sends, 0);
  await rejects(
    as("hr", () =>
      review(
        {
          documentId: doc.documentId,
          expectedVersion: 1,
          reviewState: "REJECTED",
          note: "No",
        },
        tenant,
        options,
      ),
    ),
    409,
  );
});
test("uncertain provider creation reconciles without sending a second invitation; link stays employee-only", async () => {
  await step();
  assert.equal(prepared, 1);
  uncertain = true;
  assert.equal((await step()).retried, 1);
  assert.equal(observedState, "CREATE_UNKNOWN");
  assert.equal(sends, 1);
  assert.equal((await byId(doc.documentId)).signatureState, "CREATE_UNKNOWN");
  await step();
  assert.equal(sends, 1);
  assert.equal((await byId(doc.documentId)).signatureState, "AWAITING");
  assert.match(
    (await as("self", () => open({ documentId: doc.documentId }, tenant))).url,
    /^https:/,
  );
  await rejects(
    as("hr", () => open({ documentId: doc.documentId }, tenant)),
    404,
  );
  assert.ok(
    !JSON.stringify(
      await as("hr", () => list({ checklistId: c.id }, tenant)),
    ).includes("/invitation/"),
  );
});
test("signed artifact must pass scanning before verified completion; retries never duplicate documents", async () => {
  const { listDocuments } =
    await import("../../src/services/onboardingSchedule.service.js");
  const pending = (await as("hr", () => listDocuments(c.id, tenant))).find(
    (d) => d.id === doc.documentId,
  );
  assert.equal(pending.signatureVerified, false);
  assert.notEqual(pending.status, "signed");
  workflow = { ...workflow, status: 3, signedAt: new Date().toISOString() };
  scanState = "PENDING";
  await step();
  assert.equal((await byId(doc.documentId)).signatureState, "AWAITING");
  const asset = [...assets.values()].at(-1);
  asset.assetScan.status = "CLEAN";
  await system(() => scan({ tenantId: tenant, damFactory }));
  scanState = "CLEAN";
  assert.equal((await step()).signed, 1);
  const row = await byId(doc.documentId);
  assert.equal(row.signatureState, "SIGNED");
  assert.equal(row.canDownloadSigned, true);
  const legacy = (await as("hr", () => listDocuments(c.id, tenant))).find(
    (d) => d.id === doc.documentId,
  );
  assert.equal(legacy.signatureVerified, true);
  assert.equal(legacy.status, "signed");
  assert.equal(
    (
      await as("self", () =>
        download({ documentId: doc.documentId, signed: true }, tenant, options),
      )
    ).contentBase64,
    signedBytes.toString("base64"),
  );
  assert.equal(
    await tx((t) =>
      t.onboardingDocument.count({
        where: { tenantId: tenant, checklistId: c.id },
      }),
    ),
    4,
  );
  await rejects(
    as("hr", () =>
      cancel({ documentId: doc.documentId, reason: "Cancel" }, tenant),
    ),
    409,
  );
  await step();
  assert.equal(sends, 1);
});
test("cancellation cleanup continues with flags off and employee cannot cancel HR requests", async () => {
  const d = await as("hr", () =>
    upload(input(7, { requiresSign: true }), tenant, options),
  );
  await as("hr", () =>
    review(
      { documentId: d.documentId, expectedVersion: 0, reviewState: "VERIFIED" },
      tenant,
      options,
    ),
  );
  await as("hr", () =>
    request(
      {
        documentId: d.documentId,
        expectedVersion: 1,
        confirmedEmail: "employee@example.test",
        recipientConfirmed: true,
      },
      tenant,
      { client, damFactory },
    ),
  );
  await rejects(
    as("self", () =>
      cancel({ documentId: d.documentId, reason: "Changed" }, tenant),
    ),
    403,
  );
  await as("hr", () =>
    cancel(
      { documentId: d.documentId, reason: "Superseded before send" },
      tenant,
    ),
  );
  process.env.HR_ONBOARDING_AUTOMATION = "off";
  process.env.HR_RECRUITMENT_LIBRESIGN = "off";
  await step();
  assert.equal((await byId(d.documentId)).signatureState, "CANCELLED");
  assert.equal(sends, 1);
  process.env.HR_ONBOARDING_AUTOMATION = "on";
  process.env.HR_RECRUITMENT_LIBRESIGN = "on";
  await rejects(
    tx((t) => requireOnboardingSignatures(t, tenant, c.id)),
    409,
  );
  await as("hr", () =>
    review(
      {
        documentId: d.documentId,
        expectedVersion: 1,
        reviewState: "REJECTED",
        note: "This duplicate agreement is withdrawn; the signed agreement remains authoritative",
      },
      tenant,
      options,
    ),
  );
  await tx((t) => requireOnboardingSignatures(t, tenant, c.id));
});
test("RLS excludes every foreign evidence row and events contain no document content or private identities", async () => {
  for (const table of [
    "OnboardingUpload",
    "OnboardingDocumentEvidence",
    "OnboardingDocumentSignature",
  ])
    assert.equal(
      (
        await tx(
          (t) => t.$queryRawUnsafe('SELECT * FROM "' + table + '"'),
          foreign,
        )
      ).length,
      0,
    );
  const events = await tx((t) =>
    t.outboxEvent.findMany({
      where: {
        tenantId: tenant,
        eventName: "hr.onboarding.document_changed.v1",
      },
    }),
  );
  assert.ok(events.length >= 9);
  const raw = JSON.stringify(events);
  for (const sensitive of [
    "employee@example.test",
    "c4.v1: Verified against original",
    "contentBase64",
    "sign.example.test",
    "%PDF",
  ])
    assert.ok(!raw.includes(sensitive));
  await tx((t) =>
    t.onboardingChecklist.update({
      where: { id: c.id },
      data: { status: "COMPLETED" },
    }),
  );
  await rejects(
    as("self", () => upload(input(8), tenant, options)),
    409,
  );
});
test.after(async () => {
  for (const tid of [tenant, foreign])
    await tx(async (t) => {
      for (const table of [
        "OnboardingUpload",
        "OnboardingDocumentSignature",
        "OnboardingDocumentEvidence",
      ])
        await t.$executeRawUnsafe(
          'DELETE FROM "' + table + '" WHERE "tenantId"=$1::uuid',
          tid,
        );
      await t.$executeRawUnsafe(
        'DELETE FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid',
        tid,
      );
      await t.onboardingChecklist.deleteMany({ where: { tenantId: tid } });
      await t.employee.deleteMany({ where: { tenant_id: tid } });
    }, tid);
  await db.$disconnect();
});
