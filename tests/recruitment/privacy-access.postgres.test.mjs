import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use isolated recruitment database");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
process.env.HR_RECRUITMENT_COMMUNICATIONS = "true";
process.env.HR_PORTAL_BASE_URL = "https://careers.example.invalid";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { registerCandidatePrivacyTools } =
  await import("../../src/mcp/tools/candidatePrivacyTools.js");
const { default: router } =
  await import("../../src/routes/recruitment.routes.js");
const { default: express } = await import("express");
const privacy = await import("../../src/services/candidatePrivacy.service.js");
const { enqueueCandidateCommunication } =
  await import("../../src/services/candidateCommunicationQueue.service.js");
const { runCandidateCommunicationDelivery } =
  await import("../../src/services/candidateCommunicationDelivery.service.js");
const { issueStatusLink } =
  await import("../../src/services/candidateVerification.service.js");
const tenant = randomUUID(),
  foreign = randomUUID(),
  handlers = {};
let employee, candidate, foreignCandidate, server, base;
registerCandidatePrivacyTools({
  tool: (name, _description, _schema, fn) => {
    handlers[name] = fn;
  },
});
const tx = (fn, t = tenant) =>
  mcpCtx.run({ user: { tenantId: t } }, () =>
    tenantTransaction(db, fn, { tenantId: t }),
  );
const context = (role = "HR_ADMIN") => ({
  actorVerified: role !== "UNVERIFIED",
  user: {
    tenantId: tenant,
    userId: employee.userId,
    employeeId: 9999999,
    roles: [role],
    isAdmin: true,
  },
  permissions: [
    "hr.recruitment.read",
    "hr.recruitment.create",
    "hr.recruitment.update",
    "hr.recruitment.delete",
  ],
});
const as = (fn, role) => mcpCtx.run(context(role), fn);
const call = async (name, args = {}, role = "HR_ADMIN") => {
  const r = await as(() => handlers[name](args), role);
  return { error: r.isError === true, data: JSON.parse(r.content[0].text) };
};
test.before(async () => {
  await tx(async (q) => {
    employee = await q.employee.create({
      data: {
        tenant_id: tenant,
        userId: randomInt(10000, 1000000000),
        employee_code: "PRIV-" + randomUUID().toUpperCase(),
        employeeCategory: "EMPLOYEE",
        first_name: "Fictional",
        status: "Active",
        employement_status: "Active",
      },
    });
    candidate = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
      },
    });
  });
  foreignCandidate = await tx(
    (q) =>
      q.candidate.create({
        data: {
          tenantId: foreign,
          firstName: "Other",
          email: randomUUID() + "@example.invalid",
        },
      }),
    foreign,
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const c = context(req.headers["x-test-role"] || "HR_ADMIN");
    req.user = c.user;
    mcpCtx.run(c, next);
  });
  app.use("/api/recruitment", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port + "/api/recruitment";
});
test("all privacy MCP tools reject non-administrators even with broad permissions and isAdmin flag", async () => {
  for (const role of [
    "RECRUITER",
    "HIRING_MANAGER",
    "INTERVIEWER",
    "FINANCE",
    "UNVERIFIED",
  ])
    for (const name of Object.keys(handlers)) {
      const r = await call(name, { candidateId: candidate.id }, role);
      assert.equal(r.error, true, name + " " + role);
      assert.equal(r.data.status, 403);
    }
});
test("privacy HTTP reads and first consent-write route require verified HR administrator", async () => {
  for (const role of [
    "RECRUITER",
    "HIRING_MANAGER",
    "INTERVIEWER",
    "FINANCE",
    "UNVERIFIED",
  ]) {
    for (const method of ["GET", "POST"]) {
      const r = await fetch(
        base + "/privacy/candidates/" + candidate.id + "/consent",
        {
          method,
          headers: { "Content-Type": "application/json", "X-Test-Role": role },
          ...(method === "POST"
            ? {
                body: JSON.stringify({
                  purpose: "PROCESSING",
                  status: "GRANTED",
                  policyVersion: "v1",
                }),
              }
            : {}),
        },
      );
      assert.equal(r.status, 403);
    }
  }
  const ok = await fetch(
    base + "/privacy/candidates/" + candidate.id + "/consent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "v1",
      }),
    },
  );
  assert.equal(ok.status, 201);
  const result = await ok.json();
  assert.equal(result.data.consent.recordedById, employee.id);
});
test("privacy consent requires policy evidence, cannot target another tenant, and uses actual employee identity", async () => {
  assert.equal(
    (
      await call("hr_candidate_consent_record", {
        candidateId: candidate.id,
        purpose: "PROCESSING",
        status: "GRANTED",
      })
    ).data.status,
    400,
  );
  assert.equal(
    (
      await call("hr_candidate_consent_list", {
        candidateId: foreignCandidate.id,
      })
    ).data.status,
    404,
  );
  const r = await call("hr_candidate_consent_record", {
    candidateId: candidate.id,
    purpose: "TALENT_POOL",
    status: "GRANTED",
    policyVersion: "v2",
  });
  assert.equal(r.error, false);
  assert.equal(r.data.consent.recordedById, employee.id);
  await assert.rejects(
    tx(async (q) => {
      await privacy.recordConsent(
        {
          tenantId: tenant,
          candidateId: candidate.id,
          purpose: "PROCESSING",
          status: "WITHDRAWN",
        },
        { db: q },
      );
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal(
    (await tx((q) => q.candidate.findUnique({ where: { id: candidate.id } })))
      .consentStatus,
    "GRANTED",
  );
  await tx((q) =>
    q.candidate.update({
      where: { id: candidate.id },
      data: { anonymizedAt: new Date() },
    }),
  );
  assert.equal(
    (
      await call("hr_candidate_consent_record", {
        candidateId: candidate.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "v2",
      })
    ).data.status,
    409,
  );
});
test("normal contact needs explicit current consent and live retention; mailbox recovery can precede application consent", async () => {
  let contact, app;
  await tx(async (q) => {
    contact = await q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Fictional",
        email: randomUUID() + "@example.invalid",
        consentStatus: "GRANTED",
      },
    });
    const job = await q.jobRequisition.create({
      data: {
        tenantId: tenant,
        title: "Fictional role",
        requestedById: employee.id,
      },
    });
    app = await q.application.create({
      data: {
        tenantId: tenant,
        candidateId: contact.id,
        jobRequisitionId: job.id,
      },
    });
    await issueStatusLink(q, { tenantId: tenant, candidate: contact });
  });
  const enqueue = (key) =>
    tx((q) =>
      enqueueCandidateCommunication(q, {
        tenantId: tenant,
        candidateId: contact.id,
        applicationId: app.id,
        templateKey: "application_stage_changed",
        dedupeKey: key,
      }),
    );
  let calls = 0;
  const work = () =>
    mcpCtx.run({ system: true }, () =>
      runCandidateCommunicationDelivery({
        tenantId: tenant,
        send: async () => {
          calls++;
          return { sent: true };
        },
      }),
    );
  const missing = await enqueue("missing-consent");
  await work();
  assert.equal(calls, 1);
  assert.equal(
    (
      await tx((q) =>
        q.candidateCommunication.findUnique({ where: { id: missing.id } }),
      )
    ).status,
    "SUPPRESSED",
  );
  await tx((q) =>
    privacy.recordConsent(
      {
        tenantId: tenant,
        candidateId: contact.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "v1",
      },
      { db: q },
    ),
  );
  const valid = await enqueue("valid-consent");
  await work();
  assert.equal(calls, 2);
  assert.equal(
    (
      await tx((q) =>
        q.candidateCommunication.findUnique({ where: { id: valid.id } }),
      )
    ).status,
    "SENT",
  );
  await tx((q) =>
    privacy.recordConsent(
      {
        tenantId: tenant,
        candidateId: contact.id,
        purpose: "PROCESSING",
        status: "WITHDRAWN",
      },
      { db: q },
    ),
  );
  const withdrawn = await enqueue("withdrawn-consent");
  await work();
  assert.equal(calls, 2);
  assert.equal(
    (
      await tx((q) =>
        q.candidateCommunication.findUnique({ where: { id: withdrawn.id } }),
      )
    ).status,
    "SUPPRESSED",
  );
  await tx((q) =>
    privacy.recordConsent(
      {
        tenantId: tenant,
        candidateId: contact.id,
        purpose: "PROCESSING",
        status: "GRANTED",
        policyVersion: "v2",
      },
      { db: q },
    ),
  );
  await tx((q) =>
    q.candidate.update({
      where: { id: contact.id },
      data: { retentionUntil: new Date(Date.now() - 1000) },
    }),
  );
  const expired = await enqueue("expired-retention");
  await work();
  assert.equal(calls, 2);
  assert.equal(
    (
      await tx((q) =>
        q.candidateCommunication.findUnique({ where: { id: expired.id } }),
      )
    ).status,
    "SUPPRESSED",
  );
});
test("access export HTTP endpoint returns a non-cacheable download and enforces administrator access", async () => {
  const subject = await tx((q) =>
    q.candidate.create({
      data: {
        tenantId: tenant,
        firstName: "Export subject",
        email: randomUUID() + "@example.invalid",
      },
    }),
  );
  const request = await as(() =>
    privacy.recordDataAccessRequest({
      tenantId: tenant,
      candidateId: subject.id,
      subjectEmail: subject.email,
      type: "ACCESS",
      actorId: employee.id,
    }),
  );
  const path = base + "/privacy/requests/" + request.id + "/export";
  const denied = await fetch(path, {
    method: "POST",
    headers: { "X-Test-Role": "RECRUITER" },
  });
  assert.equal(denied.status, 403);
  const response = await fetch(path, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(
    response.headers
      .get("content-disposition")
      .includes("candidate-access-request-" + request.id + ".json"),
  );
  const data = await response.json();
  assert.equal(data.candidateId, subject.id);
  assert.equal(data.sections.candidate[0].email, subject.email);
  const row = await tx((q) =>
    q.candidateDataAccessRequest.findUnique({ where: { id: request.id } }),
  );
  assert.equal(row.status, "IN_PROGRESS");
  await assert.rejects(
    as(() =>
      privacy.recordDataAccessRequest({
        tenantId: tenant,
        candidateId: subject.id,
        subjectEmail: "wrong@example.invalid",
        type: "ACCESS",
        actorId: employee.id,
      }),
    ),
    (e) => e.code === "HR-5702",
  );
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await db.$disconnect();
});
