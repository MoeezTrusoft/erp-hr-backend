import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt, createHash, randomBytes } from "node:crypto";
import pg from "pg";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 27).toString("base64");
process.env.HR_RECRUITMENT_LIBRESIGN = "true";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const letters = await import("../../src/services/offerLetter.service.js");
const portal = await import("../../src/services/candidateOffer.service.js");
const signing = await import("../../src/services/offerSignature.service.js");
const settings =
  await import("../../src/services/recruitmentSettings.service.js");
const { updateOffer, sendOffer, respondOffer } =
  await import("../../src/services/offer.service.js");
const { createOfferFull, markOfferPreboarding } =
  await import("../../src/services/offerMgmt.service.js");
const tenant = randomUUID(),
  other = randomUUID();
const pdf = Buffer.from("%PDF-1.4\nfictional offer fixture\n%%EOF");
const signed = Buffer.from("%PDF-1.4\nfictional signed fixture\n%%EOF");
const sha = (x) => createHash("sha256").update(x).digest("hex");
let staff,
  department,
  media = 800000;
const as = (fn, extra = {}) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: tenant,
        userId: staff?.userId,
        roles: ["HR_ADMIN"],
        ...extra,
      },
      permissions: [
        "hr.recruitment.read",
        "hr.recruitment.create",
        "hr.recruitment.update",
        "hr.payroll.read",
      ],
    },
    fn,
  );
const tx = (fn) => as(() => tenantTransaction(db, fn, { tenantId: tenant }));
const adminUrl = new URL(process.env.ASSESSMENT_TEST_ADMIN_URL || "http://invalid");
if (adminUrl.hostname !== url.hostname || adminUrl.port !== url.port ||
    adminUrl.pathname !== url.pathname || adminUrl.username !== "postgres" || !adminUrl.password)
  throw new Error("Explicit isolated fixture owner connection required");
const admin = new pg.Client({ connectionString: adminUrl.href });
const upload = async () => [{ id: ++media }];
test.before(async () => {
  await admin.connect();
  await tx(async (q) => {
    staff = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(100000, 999999999),
        employee_code: "LS-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
      },
    });
    department = await q.businessUnit.create({
      data: { tenantId: tenant, name: "Fictional signing" },
    });
  });
});
async function fixture(extra = {}) {
  return tx(async (q) => {
    const c = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional signer",
        email: randomUUID() + "@example.invalid",
        emailVerifiedAt: new Date(),
        consentStatus: "GRANTED",
      },
    });
    await q.candidateConsent.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "test",
      },
    });
    const r = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Fictional editor",
        departmentId: department.id,
        requestedById: staff.id,
        status: "DRAFT",
      },
    });
    const a = await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        jobRequisitionId: r.id,
        stage: "offer",
        status: "open",
      },
    });
    return q.offer.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        applicationId: a.id,
        jobRequisitionId: r.id,
        salary: "100000",
        currency: "PKR",
        employeeCategory: "EMPLOYEE",
        createdById: staff.id,
        ...extra,
      },
    });
  });
}
async function letter(o) {
  return as(() =>
    letters.createOfferLetter(
      { offerId: o.id, expectedVersion: o.version },
      { upload, file: { buffer: pdf } },
    ),
  );
}
async function jobFor(o) {
  return tx(
    async (q) =>
      (
        await q.$queryRawUnsafe(
          'SELECT * FROM offer_signature_requests WHERE "tenantId"=$1::uuid AND "offerId"=$2',
          tenant,
          o.id,
        )
      )[0],
  );
}
async function queued(o) {
  await letter(o);
  await tx(async (q) =>
    signing.queueOfferSignature(
      q,
      await q.offer.findFirst({ where: { id: o.id, tenantId: tenant } }),
    ),
  ); // Only fixture setup bypasses the separate Approval Centre send trigger.
  await admin.query("BEGIN");
  try {
    await admin.query(
      'INSERT INTO "HrApprovalRequest" (id,"tenantId",kind,"sourceRef","employeeCode",stage,"sourceHash",snapshot,"updatedAt") VALUES ($1,$2,\'OFFER\',$3,$4,\'APPROVED\',\'fixture\',\'{}\',now())',
      [randomUUID(), tenant, String(o.id), staff.employee_code],
    );
    await admin.query(
      "SELECT set_config('app.hr_approval_finalizing',$1,true)",
      ["OFFER:" + o.id],
    );
    await admin.query(
      "UPDATE offers SET status='SENT' WHERE id=$1 AND \"tenantId\"=$2",
      [o.id, tenant],
    );
    await admin.query("COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }
  return jobFor(o);
}
const work = (opts = {}) =>
  mcpCtx.run({ system: true }, () =>
    signing.runOfferSignatures({
      tenantId: tenant,
      now: new Date(Date.now() + 120000),
      ...opts,
    }),
  );
const makeDue = async (id) =>
  tx((q) =>
    q.$executeRawUnsafe(
      'UPDATE offer_signature_requests SET "dueAt"=now() WHERE id=$1::uuid',
      id,
    ),
  );
const workflow = {
  fileId: 51,
  fileUuid: randomUUID(),
  status: 1,
  declined: false,
  signingUrl: "https://sign.example.invalid/session",
};
function api(overrides = {}) {
  return {
    prepareDocument: async () => ({ nodeId: 41 }),
    requestSignature: async () => workflow,
    reconcile: async () => workflow,
    downloadSigned: async () => ({
      bytes: signed,
      sha256: sha(signed),
      workflow: { ...workflow, status: 3, signedAt: new Date().toISOString() },
    }),
    cancel: async () => ({ cancelled: true }),
    erase: async () => ({ erased: true }),
    ...overrides,
  };
}
test("letter revision uses the verified author, enforces CAS and binds approval media", async () => {
  const o = await fixture();
  const l = await letter(o);
  assert.equal(l.version, 1);
  assert.equal(l.offerVersion, o.version + 1);
  assert.equal(l.sha256, sha(pdf));
  const history = await as(() => letters.listOfferLetters({ offerId: o.id }), {
    employeeId: 99999,
  });
  assert.equal(history.items[0].createdById, staff.id);
  await assert.rejects(letter(o), (e) => e.status === 412);
  await assert.rejects(
    as(() => letters.listOfferLetters({ offerId: o.id }), {
      roles: ["INTERVIEWER"],
    }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    as(() => letters.listOfferLetters({ offerId: o.id }), { tenantId: other }),
    (e) => e.status >= 400,
  );
  await as(() =>
    updateOffer(
      o.id,
      { salary: 120000, expectedVersion: l.offerVersion },
      tenant,
    ),
  );
  await assert.rejects(
    tx(async (q) =>
      signing.queueOfferSignature(
        q,
        await q.offer.findFirst({ where: { id: o.id, tenantId: tenant } }),
      ),
    ),
    (e) => e.status === 422,
  );
});
test("signature request requires verified email and current immutable letter", async () => {
  const o = await fixture();
  await letter(o);
  await tx((q) =>
    q.candidate.update({
      where: { id: o.candidateId },
      data: { emailVerifiedAt: null },
    }),
  );
  await assert.rejects(
    tx(async (q) =>
      signing.queueOfferSignature(
        q,
        await q.offer.findFirst({ where: { id: o.id, tenantId: tenant } }),
      ),
    ),
    (e) => e.status === 422,
  );
});
test("durable creation recovers unknown outcomes by reading only", async () => {
  const o = await fixture(),
    j = await queued(o);
  let posts = 0,
    reads = 0;
  const client = async () =>
    api({
      requestSignature: async () => {
        posts++;
        throw new Error("timeout with private data");
      },
      reconcile: async () => {
        reads++;
        return workflow;
      },
    });
  await work({ client, download: async () => pdf });
  assert.equal((await jobFor(o)).state, "CREATE");
  await makeDue(j.id);
  await work({ client });
  assert.equal((await jobFor(o)).state, "CREATE_UNKNOWN");
  await makeDue(j.id);
  await work({ client });
  assert.equal((await jobFor(o)).state, "AWAITING");
  assert.equal(posts, 1);
  assert.equal(reads, 1);
  assert.ok(!(await jobFor(o)).lastError);
  await assert.rejects(
    tx(async (q) =>
      signing.requireOfferSignature(
        q,
        await q.offer.findFirst({ where: { id: o.id, tenantId: tenant } }),
      ),
    ),
    (e) => e.status === 409,
  );
});
test("confirmed provider rejection can retry while uncertain creation remains protected", async () => {
  const o = await fixture(),
    j = await queued(o);
  await work({ client: async () => api(), download: async () => pdf });
  let posts = 0;
  const client = async () =>
    api({
      requestSignature: async () => {
        posts++;
        if (posts === 1)
          throw Object.assign(new Error("rejected"), {
            reason: "PROVIDER_REJECTED",
            uncertain: false,
          });
        return workflow;
      },
    });
  await makeDue(j.id);
  await work({ client });
  assert.equal((await jobFor(o)).state, "CREATE");
  await makeDue(j.id);
  await work({ client });
  assert.equal((await jobFor(o)).state, "AWAITING");
  assert.equal(posts, 2);
});
test("concurrent workers claim one provider operation and preserve an erasure arriving during upload", async () => {
  const o = await fixture(),
    j = await queued(o);
  let entered, release;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  let calls = 0;
  const client = async () =>
    api({
      prepareDocument: async () => {
        calls++;
        entered();
        await gate;
        return { nodeId: 91 };
      },
    });
  const running = work({ client, download: async () => pdf });
  await Promise.race([
    started,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("worker did not start provider operation")),
        10000,
      ),
    ),
  ]);
  await work({ client, download: async () => pdf });
  assert.equal(calls, 1);
  await tx((q) =>
    q.candidate.update({
      where: { id: o.candidateId },
      data: { anonymizedAt: new Date() },
    }),
  );
  release();
  await running;
  const pending = await jobFor(o);
  assert.equal(pending.state, "ERASE_PENDING");
  assert.equal(pending.nodeId, 91);
  let erased;
  process.env.HR_RECRUITMENT_LIBRESIGN = "false";
  await makeDue(j.id);
  await work({
    client: async () =>
      api({
        erase: async (expected) => {
          erased = expected;
          return { erased: true };
        },
      }),
  });
  process.env.HR_RECRUITMENT_LIBRESIGN = "true";
  assert.equal(erased.nodeId, 91);
  assert.equal((await jobFor(o)).state, "ERASED");
  assert.equal((await jobFor(o)).identityCipher, null);
});
test("signed PDF is stored before acceptance and scheduler identity is mandatory", async () => {
  const o = await fixture(),
    j = await queued(o);
  await work({ client: async () => api(), download: async () => pdf });
  await makeDue(j.id);
  await work({ client: async () => api() });
  await makeDue(j.id);
  await work({
    client: async () =>
      api({ reconcile: async () => ({ ...workflow, status: 3 }) }),
    storePdf: async (input) => {
      assert.equal(input.purpose, "SIGNED_OFFER");
      return { mediaId: ++media, sha256: sha(input.bytes) };
    },
  });
  const complete = await jobFor(o);
  assert.equal(complete.state, "SIGNED");
  assert.equal(complete.signedSha256, sha(signed));
  assert.equal(complete.signingUrlCipher, null);
  await tx(async (q) =>
    signing.requireOfferSignature(
      q,
      await q.offer.findFirst({ where: { id: o.id, tenantId: tenant } }),
    ),
  );
  await makeDue(j.id);
  let accepted = 0;
  await work({
    client: async () => api(),
    accept: async (id, value, tid) => {
      assert.equal(id, o.id);
      assert.equal(value, true);
      assert.equal(tid, tenant);
      accepted++;
    },
  });
  assert.equal(accepted, 1);
  await assert.rejects(
    as(() => signing.runOfferSignatures()),
    (e) => e.status === 403,
  );
});
test("an unconfigured company cannot consume approval or report an offer as sent", async () => {
  const o = await fixture();
  await letter(o);
  const previous = process.env.HR_LIBRESIGN_CONFIG_FILE;
  delete process.env.HR_LIBRESIGN_CONFIG_FILE;
  try {
    await assert.rejects(
      as(() => sendOffer(o.id, tenant)),
      { code: "HR-5510", reason: "CONFIGURATION" },
    );
    assert.equal(
      (
        await tx((q) =>
          q.offer.findFirst({ where: { id: o.id, tenantId: tenant } }),
        )
      ).status,
      "DRAFT",
    );
    assert.equal(await jobFor(o), undefined);
  } finally {
    if (previous !== undefined) process.env.HR_LIBRESIGN_CONFIG_FILE = previous;
  }
});
test("candidate offer reads and PDF downloads require the owning live status token", async () => {
  const o = await fixture();
  await queued(o);
  const foreign = await fixture();
  await queued(foreign);
  const token = randomBytes(32).toString("base64url");
  await tx(async (q) => {
    const c = await q.candidate.findFirst({
      where: { id: o.candidateId, tenantId: tenant },
    });
    await q.candidateEmailVerification.create({
      data: {
        tenantId: tenant,
        candidateId: c.id,
        email: c.email,
        purpose: "STATUS_LINK",
        tokenHash: sha(token),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });
  const input = { tenantId: tenant, token };
  const list = await as(() => portal.listOwnOffers(input));
  assert.deepEqual(
    list.items.map((x) => x.id),
    [o.id],
  );
  assert.equal(list.items[0].notes, undefined);
  assert.equal(list.items[0].signingUrl, null);
  let reads = 0;
  const download = async (tid, id) => {
    reads++;
    assert.equal(tid, tenant);
    assert.ok(id > 0);
    return pdf;
  };
  assert.deepEqual(
    await as(() =>
      portal.downloadOwnOffer({ ...input, offerId: o.id }, { download }),
    ),
    pdf,
  );
  await assert.rejects(
    as(() =>
      portal.downloadOwnOffer({ ...input, offerId: foreign.id }, { download }),
    ),
    (e) => e.status === 404,
  );
  assert.equal(reads, 1);
  await assert.rejects(
    as(() =>
      portal.respondToOwnOffer({
        ...input,
        offerId: foreign.id,
        accepted: true,
      }),
    ),
    (e) => e.status === 404,
  );
  await assert.rejects(
    as(() =>
      portal.respondToOwnOffer({ ...input, offerId: o.id, accepted: true }),
    ),
    (e) => e.code === "HR-5510",
  );
  await assert.rejects(
    as(() =>
      portal.downloadOwnOffer(
        { ...input, offerId: o.id },
        { download: async () => signed },
      ),
    ),
    (e) => e.status === 404,
  );
  await assert.rejects(
    as(() =>
      portal.downloadOwnOffer(
        { ...input, offerId: o.id },
        {
          download: async () => {
            await tx((q) =>
              q.candidateEmailVerification.updateMany({
                where: { tenantId: tenant, tokenHash: sha(token) },
                data: { consumedAt: new Date() },
              }),
            );
            return pdf;
          },
        },
      ),
    ),
    (e) => e.status === 404,
  );
  await assert.rejects(
    as(() => portal.listOwnOffers(input)),
    (e) => e.status === 404,
  );
});
test("terminal offers enqueue cancellation without discarding provider identity", async () => {
  const o = await fixture();
  const j = await queued(o);
  await work({ client: async () => api(), download: async () => pdf });
  await tx((q) =>
    q.offer.update({ where: { id: o.id }, data: { status: "EXPIRED" } }),
  );
  assert.equal((await jobFor(o)).state, "CANCEL_PENDING");
  let cancelled = 0;
  await makeDue(j.id);
  await work({
    client: async () =>
      api({
        cancel: async (expected) => {
          assert.equal(expected.nodeId, 41);
          cancelled++;
          return { cancelled: true };
        },
      }),
  });
  assert.equal(cancelled, 1);
  assert.equal((await jobFor(o)).state, "CANCELLED");
});
test("expiry reconciles a signature completed before the deadline", async () => {
  const expiry = new Date(Date.now() + 300000),
    o = await fixture({ expiryDate: expiry }),
    j = await queued(o);
  await work({ client: async () => api(), download: async () => pdf });
  await makeDue(j.id);
  await work({ client: async () => api() });
  await makeDue(j.id);
  let cancelled = 0;
  const proof = {
    ...workflow,
    status: 3,
    signedAt: new Date(expiry.getTime() - 1000).toISOString(),
  };
  await work({
    now: new Date(expiry.getTime() + 1000),
    client: async () =>
      api({
        reconcile: async () => proof,
        downloadSigned: async () => ({
          bytes: signed,
          sha256: sha(signed),
          workflow: proof,
        }),
        cancel: async () => {
          cancelled++;
        },
      }),
    storePdf: async (input) => ({ mediaId: ++media, sha256: sha(input.bytes) }),
  });
  assert.equal(cancelled, 0);
  assert.equal((await jobFor(o)).state, "SIGNED");
  assert.equal(
    (
      await tx((q) =>
        q.offer.findFirst({ where: { id: o.id, tenantId: tenant } }),
      )
    ).status,
    "SENT",
  );
  await makeDue(j.id);
  let accepted = 0;
  await work({
    now: new Date(expiry.getTime() + 5000),
    accept: async (id, value) => {
      assert.equal(id, o.id);
      assert.equal(value, true);
      accepted++;
    },
  });
  assert.equal(accepted, 1);
});
test("unsigned expiry cancels the provider before expiring the offer", async () => {
  const expiry = new Date(Date.now() + 300000),
    o = await fixture({ expiryDate: expiry }),
    j = await queued(o);
  await work({ client: async () => api(), download: async () => pdf });
  await makeDue(j.id);
  await work({ client: async () => api() });
  await makeDue(j.id);
  let cancelled = 0;
  await work({
    now: new Date(expiry.getTime() + 1000),
    client: async () =>
      api({
        cancel: async () => {
          cancelled++;
          return { cancelled: true };
        },
      }),
  });
  assert.equal(cancelled, 1);
  assert.equal((await jobFor(o)).state, "CANCELLED");
  assert.equal(
    (
      await tx((q) =>
        q.offer.findFirst({ where: { id: o.id, tenantId: tenant } }),
      )
    ).status,
    "EXPIRED",
  );
});
test("provider decline is applied through the offer response workflow", async () => {
  const o = await fixture(),
    j = await queued(o);
  await work({ client: async () => api(), download: async () => pdf });
  await makeDue(j.id);
  await work({ client: async () => api() });
  await makeDue(j.id);
  await work({
    client: async () =>
      api({ reconcile: async () => ({ ...workflow, declined: true }) }),
  });
  assert.equal((await jobFor(o)).state, "DECLINED");
  await makeDue(j.id);
  let declined = 0;
  await work({
    accept: async (id, value) => {
      assert.equal(id, o.id);
      assert.equal(value, false);
      declined++;
    },
  });
  assert.equal(declined, 1);
});
test("staff PDF downloads enforce role, tenant, checksum and late erasure", async () => {
  const o = await fixture(),
    l = await letter(o),
    input = { offerId: o.id, letterId: l.id };
  const result = await as(() =>
    letters.downloadOfferLetter(input, { download: async () => pdf }),
  );
  assert.equal(result.base64, pdf.toString("base64"));
  assert.match(result.fileName, /\.pdf$/);
  await assert.rejects(
    as(
      () => letters.downloadOfferLetter(input, { download: async () => pdf }),
      { roles: ["INTERVIEWER"] },
    ),
    (e) => e.status === 403,
  );
  await assert.rejects(
    as(() =>
      letters.downloadOfferLetter(
        { ...input, offerId: o.id + 100000 },
        { download: async () => pdf },
      ),
    ),
    (e) => e.status === 404,
  );
  await assert.rejects(
    as(() =>
      letters.downloadOfferLetter(input, { download: async () => signed }),
    ),
    (e) => e.status === 502,
  );
  await assert.rejects(
    as(() =>
      letters.downloadOfferLetter(input, {
        download: async () => {
          await tx((q) =>
            q.candidate.update({
              where: { id: o.candidateId },
              data: { anonymizedAt: new Date() },
            }),
          );
          return pdf;
        },
      }),
    ),
    (e) => e.status === 404,
  );
});
test("company templates are versioned, tenant-owned and frozen on generated letters", async () => {
  const policy = {
    offerLetterTemplate: {
      employerName: "Fictional Company A",
      openingText:
        "Welcome {{candidateName}} to {{employerName}} as {{positionTitle}}.",
    },
  };
  await as(() =>
    settings.recruitmentSettingsSet({
      policy,
      expectedVersion: 0,
      reason: "Configure the fictional company offer template",
    }),
  );
  const o = await fixture();
  let uploads = 0;
  await assert.rejects(
    as(() =>
      letters.createOfferLetter(
        {
          offerId: o.id,
          expectedVersion: o.version,
          employerName: "Another company",
        },
        {
          upload: async () => {
            uploads++;
            return [{ id: ++media }];
          },
        },
      ),
    ),
    (e) => e.status === 422,
  );
  assert.equal(uploads, 0);
  const created = await as(() =>
    letters.createOfferLetter(
      { offerId: o.id, expectedVersion: o.version },
      {
        upload: async (file) => {
          uploads++;
          assert.equal(file.buffer.subarray(0, 5).toString(), "%PDF-");
          return [{ id: ++media }];
        },
      },
    ),
  );
  assert.equal(created.templateVersion, 1);
  await as(() =>
    settings.recruitmentSettingsSet({
      policy: {
        offerLetterTemplate: { employerName: "Fictional Company A revised" },
      },
      expectedVersion: 1,
      reason: "Revise the fictional company template",
    }),
  );
  const history = await as(() => letters.listOfferLetters({ offerId: o.id }));
  assert.equal(history.items[0].templateVersion, 1);
  await assert.rejects(
    tx((q) =>
      q.$executeRawUnsafe(
        'UPDATE offer_letter_versions SET "templateVersion"=2 WHERE id=$1::uuid',
        created.id,
      ),
    ),
    /immutable/,
  );
  const otherPolicy = await as(
    () =>
      tenantTransaction(db, (q) => settings.readRecruitmentSettings(q, other), {
        tenantId: other,
      }),
    { tenantId: other },
  );
  assert.equal(otherPolicy.policy.offerLetterTemplate, null);
  await assert.rejects(
    as(
      () =>
        settings.recruitmentSettingsSet({
          policy,
          expectedVersion: 2,
          reason: "Manager cannot edit company templates",
        }),
      { roles: ["HIRING_MANAGER"] },
    ),
    (e) => e.status === 403,
  );
  await assert.rejects(
    as(() =>
      settings.recruitmentSettingsSet({
        policy: {
          offerLetterTemplate: {
            employerName: "Fictional Company A",
            openingText: "{{recruiterNotes}}",
          },
        },
        expectedVersion: 2,
        reason: "Reject unsupported private merge fields",
      }),
    ),
  );
});
test("full offer creation validates approved terms and compensation before any write", async () => {
  const old = await fixture();
  await tx((q) => q.offer.delete({ where: { id: old.id } }));
  const input = {
    applicationId: old.applicationId,
    candidateId: old.candidateId,
    jobRequisitionId: old.jobRequisitionId,
    employeeCategory: "EMPLOYEE",
    baseSalary: 120000,
    currency: "PKR",
    probationMonths: 3,
    noticePeriodDays: 30,
    bonus: "Performance-based",
    allowances: "5000",
    benefits: ["Health"],
    startDate: "2030-01-01",
  };
  for (const invalid of [
    { bonus: "-1000" },
    { allowances: "-1,000" },
    { probationMonths: 121 },
    { noticePeriodDays: 731 },
    { currency: "invalid" },
    { startDate: "2030-02-31" },
    { candidateId: old.candidateId + 0.5 },
    { benefits: [false] },
    { unexpectedClause: "ignored" },
  ]) {
    await assert.rejects(
      as(() => createOfferFull({ ...input, ...invalid }, { tenantId: tenant })),
      (e) => e.code === "HR-5511" && e.status === 422,
    );
  }
  assert.equal(
    await tx((q) =>
      q.offer.count({ where: { applicationId: old.applicationId } }),
    ),
    0,
  );
  const created = await as(() =>
    createOfferFull(input, { tenantId: tenant, showSensitive: true }),
  );
  assert.equal(created.compensation.baseSalary, 120000);
  assert.equal(created.terms.probationMonths, 3);
  await assert.rejects(
    as(() =>
      updateOffer(created.offerId, { compensation: { bonus: "-1" } }, tenant),
    ),
  );
});

test("preboarding preserves accepted terms, records the verified actor once and rechecks consent", async () => {
  process.env.HR_RECRUITMENT_OFFER_HANDOFF = "true";
  const o = await fixture({
    status: "ACCEPTED",
    terms: { probationMonths: 3 },
    notes: "Approved offer notes",
  });
  const checklist = await tx((q) =>
    q.onboardingChecklist.create({
      data: {
        tenantId: tenant,
        employeeId: staff.id,
        startDate: new Date(),
        currentStage: "pre_joining",
      },
    }),
  );
  await tx((q) =>
    q.offerHandoff.create({
      data: {
        tenantId: tenant,
        offerId: o.id,
        status: "COMPLETED",
        employeeId: staff.id,
        checklistId: checklist.id,
        completedAt: new Date(),
      },
    }),
  );
  await as(() =>
    markOfferPreboarding(o.id, { tenantId: tenant, note: "Prepare access" }),
  );
  await as(() =>
    markOfferPreboarding(o.id, { tenantId: tenant, note: "Retry" }),
  );
  const after = await tx((q) => q.offer.findFirst({ where: { id: o.id } }));
  assert.deepEqual(after.terms, o.terms);
  assert.equal(after.notes, o.notes);
  assert.equal(after.version, o.version);
  const board = await tx((q) =>
    q.onboardingChecklist.findFirst({ where: { id: checklist.id } }),
  );
  assert.equal(board.currentStage, "pre_boarding");
  assert.equal(board.activityLog.length, 1);
  assert.equal(board.activityLog[0].actor, staff.id);
  assert.match(board.activityLog[0].text, /Prepare access/);
  await assert.rejects(
    as(() => markOfferPreboarding(o.id, { tenantId: tenant }), {
      roles: ["HIRING_MANAGER"],
    }),
    (e) => e.status === 403,
  );
  await tx((q) =>
    q.candidate.update({
      where: { id: o.candidateId },
      data: { consentStatus: "WITHDRAWN" },
    }),
  );
  await assert.rejects(
    as(() => markOfferPreboarding(o.id, { tenantId: tenant })),
    (e) => e.status === 403 || e.status === 409,
  );
  process.env.HR_RECRUITMENT_OFFER_HANDOFF = "false";
});

test("accepted response replay rechecks live candidate authorization and never repeats the handoff", async () => {
  process.env.HR_RECRUITMENT_OFFER_HANDOFF = "true";
  try {
    const o = await fixture({ status: "ACCEPTED" });
    const first = await as(() =>
      respondOffer(o.id, true, tenant, { candidateId: o.candidateId }),
    );
    assert.equal(first.replayed, true);
    assert.equal(first.handoff, null);
    assert.equal(
      await tx((q) => q.offerHandoff.count({ where: { offerId: o.id } })),
      0,
    );
    await assert.rejects(
      as(() =>
        respondOffer(o.id, true, tenant, {
          candidateId: o.candidateId,
          candidateToken: "expired-or-revoked",
        }),
      ),
    );
    await tx((q) =>
      q.candidate.update({
        where: { id: o.candidateId },
        data: { consentStatus: "WITHDRAWN" },
      }),
    );
    await assert.rejects(
      as(() =>
        respondOffer(o.id, true, tenant, { candidateId: o.candidateId }),
      ),
      (e) => e.status === 403 || e.status === 409,
    );
  } finally {
    process.env.HR_RECRUITMENT_OFFER_HANDOFF = "false";
  }
});

test.afterEach(async () => {
  await tx((q) =>
    q.$executeRawUnsafe(
      'UPDATE offer_signature_requests SET "dueAt"=$1 WHERE "tenantId"=$2::uuid',
      new Date("9999-01-01T00:00:00Z"),
      tenant,
    ),
  );
});
test.after(async () => {
  await admin.end();
  await db.$disconnect();
});
