import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
const { encryptString } = await import("../../src/lib/crypto.js");
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { exportCandidateDataRequest } =
  await import("../../src/services/candidateDataExport.service.js");
const privacy = await import("../../src/services/candidatePrivacy.service.js");
const { CANDIDATE_EXPORT_FIELDS, CANDIDATE_EXPORT_SOURCES } =
  await import("../../src/services/candidateDataExport.catalog.js");
const tenant = randomUUID(),
  foreign = randomUUID();
let staff,
  candidate,
  other,
  foreignCandidate,
  application,
  interview,
  session,
  request;
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, { tenantId: t, txOptions: { timeout: 30000 } }),
  );
const as = (fn, role = "HR_ADMIN") =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: {
        tenantId: tenant,
        userId: staff.userId,
        employeeId: 9999999,
        roles: [role],
        isAdmin: true,
      },
      permissions: [
        "hr.recruitment.read",
        "hr.recruitment.create",
        "hr.recruitment.update",
      ],
      correlationId: "data-export-test",
    },
    fn,
  );
const exportRequest = (id = request.id, role) =>
  as(() => exportCandidateDataRequest({ tenantId: tenant, id }), role);
const newRequest = (data = {}) =>
  tx((q) =>
    q.candidateDataAccessRequest.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        subjectEmail: candidate.email,
        type: "ACCESS",
        dueAt: new Date(Date.now() + 30 * 86400000),
        ...data,
      },
    }),
  );
test.before(async () => {
  await tx(async (q) => {
    staff = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 1000000000),
        employee_code: "DSR-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
      },
    });
    candidate = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Export subject",
        email: randomUUID() + "@example.invalid",
        notes: "Candidate-specific note",
        consentStatus: "WITHDRAWN",
      },
    });
    other = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "NOT_THIS_SUBJECT",
        email: randomUUID() + "@example.invalid",
      },
    });
    const job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Export fixture",
        requestedById: staff.id,
      },
    });
    application = await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        jobRequisitionId: job.id,
      },
    });
    await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: other.id,
        jobRequisitionId: job.id,
      },
    });
    const offer = await q.offer.create({
        data: {
          tenantId: tenant,
          applicationId: application.id,
          candidateId: candidate.id,
          jobRequisitionId: job.id,
          salary: "100000",
          createdById: staff.id,
        },
      }),
      letterId = randomUUID();
    await q.$executeRawUnsafe(
      'INSERT INTO offer_letter_versions(id,"tenantId","offerId","candidateId",version,"offerRevision",sha256,"createdById") VALUES($1::uuid,$2::uuid,$3,$4,1,0,$5,$6)',
      letterId,
      tenant,
      offer.id,
      candidate.id,
      "a".repeat(64),
      staff.id,
    );
    await q.$executeRawUnsafe(
      'INSERT INTO offer_signature_requests(id,"tenantId","offerId","candidateId","letterId","identityCipher","signingUrlCipher") VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7)',
      randomUUID(),
      tenant,
      offer.id,
      candidate.id,
      letterId,
      "SECRET_IDENTITY_CIPHER",
      "SECRET_SIGNING_LINK",
    );
    await q.candidateSkill.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        name: "Editing",
        score: 80,
      },
    });
    await q.candidateSkill.create({
      data: {
        tenantId: tenant,
        candidateId: other.id,
        name: "NOT_THIS_SUBJECT",
      },
    });
    const question = await q.applicationQuestion.create({
      data: {
        requisitionId: job.id,
        prompt: "Why this role?",
        type: "TEXT_LONG",
        tenantId: tenant,
      },
    });
    await q.applicationAnswer.create({
      data: {
        applicationId: application.id,
        questionId: question.id,
        value: "My editing experience",
      },
    });
    await q.$executeRawUnsafe(
      `INSERT INTO "InterviewSlotOffer" ("tenantId","applicationId","createdById","interviewType","durationMinutes",location,panel,slots,"expiresAt") VALUES ($1::uuid,$2,$3,'VIDEO',60,'Private scheduling location',$4::jsonb,$5::jsonb,$6)`,
      tenant,
      application.id,
      staff.id,
      JSON.stringify([{ employeeId: staff.id, panelRole: null }]),
      JSON.stringify([
        "2030-01-07T04:00:00.000Z",
        "2030-01-07T06:00:00.000Z",
        "2030-01-07T08:00:00.000Z",
      ]),
      new Date("2030-01-06T04:00:00Z"),
    );
    interview = await q.interview.create({
      data: {
        tenantId: tenant,
        applicationId: application.id,
        interviewType: "ONSITE",
        scheduledAt: new Date(),
      },
    });
    const blueprint = await q.candidateTestBlueprint.create({
      data: {
        tenantId: tenant,
        name: "Export fixture",
        jobFamily: "EDITOR",
        sections: [],
        createdById: staff.id,
      },
    });
    const station = await q.testWorkstation.create({
      data: {
        tenantId: tenant,
        label: "Export fixture",
        siteRef: "TEST",
        deviceTokenHash: randomUUID(),
        registeredById: staff.id,
        tokenExpiresAt: new Date(Date.now() + 86400000),
      },
    });
    session = await q.candidateTestSession.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        applicationId: application.id,
        interviewId: interview.id,
        blueprintId: blueprint.id,
        blueprintVersion: 1,
        blueprintSnapshot: { answerKey: "SECRET_TEST_KEY" },
        workstationId: station.id,
        sessionCodeHash: "SECRET_SESSION_HASH",
        accessTokenHash: "SECRET_ACCESS_HASH",
        codeExpiresAt: new Date(Date.now() + 60000),
        itemOrder: [{ answerKey: "SECRET_TEST_KEY" }],
        issuedById: staff.id,
      },
    });
    await q.candidateTestResult.create({
      data: {
        tenantId: tenant,
        sessionId: session.id,
        applicationId: application.id,
        interviewId: interview.id,
        rawScore: 8,
        maxScore: 10,
        scorePct: 80,
        sectionScores: [{ key: "editing", scorePct: 80 }],
        mustPassFailed: false,
        band: "PASSED",
        integrityFlagCount: 0,
      },
    });
    await q.$executeRawUnsafe(
      'INSERT INTO "InterviewStaffNotice" ("tenantId","interviewId","recipientUserId","scheduledAt",kind) VALUES($1::uuid,$2,$3,$4,$5)',
      tenant,
      interview.id,
      staff.userId,
      interview.scheduledAt,
      "FEEDBACK_DUE",
    );
    await q.candidateCheckIn.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        interviewId: interview.id,
        idType: "CNIC",
        idLast4: "1234",
        verifiedById: staff.id,
        consentAt: new Date(),
      },
    });
    await q.applicationDraft.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        requisitionId: job.id,
        payload: {
          firstName: "Export subject",
          nested: { token: "SECRET_NESTED_TOKEN" },
        },
        tokenHash: "SECRET_DRAFT_HASH" + randomUUID(),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await q.candidateEmailVerification.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        email: candidate.email,
        tokenHash: "SECRET_MAILBOX_HASH" + randomUUID(),
        purpose: "STATUS_LINK",
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await q.candidateCommunication.create({
      data: {
        tenantId: tenant,
        candidateId: candidate.id,
        templateKey: "candidate_status_link",
        dedupeKey: randomUUID(),
        context: {
          tokenHash: "SECRET_MESSAGE_HASH",
          tokenPurpose: "STATUS_LINK",
        },
        encryptedPayload: encryptString("SECRET_CIPHERTEXT"),
        leaseToken: "SECRET_LEASE",
      },
    });
    await q.candidateDncEntry.create({
      data: {
        tenantId: tenant,
        email: candidate.email,
        reasonCode: "CANDIDATE_REQUEST",
        reason: "Do not contact",
      },
    });
  });
  foreignCandidate = await tx(
    (q) =>
      q.candidate.create({
        data: {
          tenantId: foreign,
          firstName: "FOREIGN_SUBJECT",
          email: randomUUID() + "@example.invalid",
        },
      }),
    foreign,
  );
  request = await newRequest();
});
test("schema review catalogue covers every candidate-linked model and excludes authentication and test bank secrets", async () => {
  const schema = await readFile(
    new URL("../../prisma/schema.prisma", import.meta.url),
    "utf8",
  );
  const direct = [...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)]
    .filter((m) => /\bcandidateId\s+Int/.test(m[2]))
    .map((m) => m[1][0].toLowerCase() + m[1].slice(1));
  const covered = new Set([
    ...Object.keys(CANDIDATE_EXPORT_FIELDS),
    ...CANDIDATE_EXPORT_SOURCES.map((s) => s.model),
  ]);
  assert.deepEqual(
    direct.filter((m) => !covered.has(m)),
    [],
  );
  for (const source of CANDIDATE_EXPORT_SOURCES)
    assert.ok(source.fields.length > 0);
  assert.ok(!covered.has("candidateTestItem"));
});
test("export includes own answers, assessment results and privacy history with no credentials or other subjects", async () => {
  const result = await exportRequest();
  const doc = JSON.parse(result.content);
  assert.equal(
    result.manifest.sha256,
    createHash("sha256").update(result.content).digest("hex"),
  );
  assert.equal(result.manifest.byteLength, Buffer.byteLength(result.content));
  assert.equal(doc.sections.candidate[0].id, candidate.id);
  assert.deepEqual(
    doc.sections.application.map((a) => a.id),
    [application.id],
  );
  assert.equal(
    doc.sections.applicationAnswer[0].value,
    "My editing experience",
  );
  assert.equal(doc.sections.candidateTestResult[0].scorePct, 80);
  assert.equal(doc.sections.candidateCheckIn[0].idLast4, "1234");
  assert.equal(doc.sections.candidateDncEntry.length, 1);
  assert.ok(!result.content.includes("SECRET_"));
  assert.ok(!result.content.includes("NOT_THIS_SUBJECT"));
  assert.ok(!result.content.includes("FOREIGN_SUBJECT"));
  assert.equal(doc.reviewRequired, true);
  assert.equal(doc.sections.offerLetterVersion.length, 1);
  assert.equal(doc.sections.offerSignatureRequest[0].state, "PREPARE");
  assert.equal(doc.sections.offerSignatureRequest[0].identityCipher, undefined);
  assert.equal(
    doc.sections.offerSignatureRequest[0].signingUrlCipher,
    undefined,
  );
  assert.equal(doc.sections.interviewStaffNotice.length, 1);
  assert.equal(doc.sections.interviewStaffNotice[0].kind, "FEEDBACK_DUE");
  assert.equal(doc.sections.interviewStaffNotice[0].recipientUserId, undefined);
  assert.equal(doc.sections.interviewSlotOffer.length, 1);
  assert.equal(
    doc.sections.interviewSlotOffer[0].location,
    "Private scheduling location",
  );
  assert.equal(doc.sections.interviewSlotOffer[0].createdById, undefined);
  const row = await tx((q) =>
    q.candidateDataAccessRequest.findUnique({ where: { id: request.id } }),
  );
  assert.equal(row.status, "IN_PROGRESS");
  assert.equal(row.handledById, staff.id);
  assert.equal(row.exportManifest.generatedById, staff.id);
  assert.equal(row.exportManifest.content, undefined);
  const logs = await tx((q) =>
    q.log.findMany({
      where: { tenantId: tenant, action_type: "CANDIDATE_ACCESS_EXPORT" },
    }),
  );
  assert.ok(
    logs.some(
      (l) =>
        l.notes.includes(result.manifest.sha256) && l.actionById === staff.id,
    ),
  );
});
test("non-administrators and foreign requests cannot generate or mutate an export", async () => {
  for (const role of ["RECRUITER", "HIRING_MANAGER", "INTERVIEWER", "FINANCE"])
    await assert.rejects(
      exportRequest(request.id, role),
      (e) => e.status === 403,
    );
  const otherRequest = await tx(
    (q) =>
      q.candidateDataAccessRequest.create({
        data: {
          tenantId: foreign,
          candidateId: foreignCandidate.id,
          subjectEmail: foreignCandidate.email,
          type: "ACCESS",
        },
      }),
    foreign,
  );
  await assert.rejects(exportRequest(otherRequest.id), (e) => e.status === 404);
  await assert.rejects(exportRequest("bad"), (e) => e.status === 400);
});
test("fulfilment requires a generated export in both service and database and remains separate from generation", async () => {
  const pending = await newRequest();
  await assert.rejects(
    as(() =>
      privacy.closeDataAccessRequest({
        tenantId: tenant,
        id: pending.id,
        status: "FULFILLED",
        actorId: staff.id,
      }),
    ),
    (e) => e.code === "HR-5702",
  );
  await assert.rejects(
    tx((q) =>
      q.candidateDataAccessRequest.update({
        where: { id: pending.id },
        data: { status: "FULFILLED" },
      }),
    ),
    /HR-5702/,
  );
  const closed = await as(() =>
    privacy.closeDataAccessRequest({
      tenantId: tenant,
      id: request.id,
      status: "FULFILLED",
      actorId: staff.id,
    }),
  );
  assert.equal(closed.status, "FULFILLED");
  await assert.rejects(exportRequest(), (e) => e.status === 409);
});
test("identity mismatches, unlinked requests and other request types fail without a partial export", async () => {
  for (const data of [
    { subjectEmail: other.email },
    { candidateId: null },
    { type: "CORRECTION" },
    { status: "REJECTED" },
  ]) {
    const row = await newRequest(data);
    await assert.rejects(exportRequest(row.id), (e) => e.status === 409);
    const after = await tx((q) =>
      q.candidateDataAccessRequest.findUnique({ where: { id: row.id } }),
    );
    assert.equal(after.exportManifest, null);
    assert.equal(after.status, row.status);
  }
});
test("candidate erasure removes slot offers and their free text", async () => {
  await tx((q) =>
    privacy.anonymizeCandidate(
      {
        tenantId: tenant,
        candidateId: candidate.id,
        reason: "Verified erasure request",
        actorId: staff.id,
      },
      { db: q },
    ),
  );
  const offers = await tx((q) =>
    q.$queryRawUnsafe(
      'SELECT id FROM "InterviewSlotOffer" WHERE "tenantId"=$1::uuid',
      tenant,
    ),
  );
  assert.equal(offers.length, 0);
  const notices = await tx((q) =>
    q.$queryRawUnsafe(
      'SELECT id FROM "InterviewStaffNotice" WHERE "tenantId"=$1::uuid',
      tenant,
    ),
  );
  assert.equal(notices.length, 0);
});
test.after(async () => db.$disconnect());
