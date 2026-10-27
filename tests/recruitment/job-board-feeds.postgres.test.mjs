import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
const url = new URL(process.env.RECRUITMENT_TEST_DATABASE_URL || "");
if (
  !process.env.KUBERNETES_SERVICE_HOST ||
  url.hostname !== "127.0.0.1" ||
  url.pathname !== "/hr_task_assessment_test" ||
  url.username !== "recruitment_test_user"
)
  throw new Error("Use the isolated Kubernetes recruitment fixture");
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = "test";
process.env.HR_C4_ENCRYPTION_KEY = Buffer.alloc(32, 27).toString("base64");
process.env.HR_RECRUITMENT_JOB_BOARD_SIGNING_KEY = Buffer.alloc(32, 83).toString("base64");
process.env.HR_PORTAL_BASE_URL = "https://www.example.invalid";
process.env.HR_PORTAL_PRIVACY_POLICY_VERSION = "board-fixture-1";
process.env.HR_PORTAL_PRIVACY_POLICY_URL = "https://www.example.invalid/privacy";
process.env.HR_RECRUITMENT_PUBLIC_PORTAL = "true";
process.env.HR_RECRUITMENT_JOB_BOARDS_ENABLED = "true";
process.env.NOTIFICATION_HUB_URL = "http://127.0.0.1:1";
process.env.NOTIFICATION_HUB_TIMEOUT = "100";
const { default: db } = await import("../../src/lib/prisma.js");
const { mcpCtx } = await import("../../src/lib/requestContext.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");
const { jobBoardFeed, resolveJobBoardSource, jobBoardApplyRedirect } =
  await import("../../src/services/job-board-feeds.service.js");
const { boardReference, issueBoardReceipt } = await import("../../src/lib/job-board-feeds.js");
const publication = await import("../../src/services/requisitionPublication.service.js");
const drafts = await import("../../src/services/applicationDraft.service.js");
const { submitPublicApplication } = await import("../../src/services/publicPortal.service.js");
const { decryptString } = await import("../../src/lib/crypto.js");
const tenantId = randomUUID(),
  foreign = randomUUID();
const company = {
  companyName: "Fictional employer",
  sourceName: "Fictional group",
  publisher: "Fictional ATS",
  publisherUrl: "https://ats.example.invalid",
  careersOrigin: "https://www." + tenantId + ".example.invalid",
  locations: { Karachi: { city: "Karachi", state: "Sindh", country: "PK" } },
  INDEED: { enabled: true, accountEmail: "indeed@example.invalid" },
  LINKEDIN: { enabled: true, accountEmail: "poster@example.invalid", companyId: "123" },
};
process.env.HR_RECRUITMENT_JOB_BOARDS = JSON.stringify({ [tenantId]: company });
process.env.HR_PORTAL_HOSTS = new URL(company.careersOrigin).hostname + "=" + tenantId;
process.env.HR_PORTAL_TRUST_EDGE_HEADER = "false";
const tx = (fn, tenant = tenantId) =>
  mcpCtx.run({ user: { tenantId: tenant } }, () => tenantTransaction(db, fn, { tenantId: tenant }));
const publicAs = (fn, tenant = tenantId) =>
  mcpCtx.run({ user: { tenantId: tenant }, publicPortal: true }, fn);
let recruiter, job, indeed, linkedIn;
const asRecruiter = (fn) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId, userId: String(recruiter.userId), roles: ["RECRUITER"] },
      permissions: ["hr.recruitment.read", "hr.recruitment.create", "hr.recruitment.update"],
    },
    fn,
  );
async function makeJob(q, actor, title = "Published feed role") {
  return q.jobRequisition.create({
    data: {
      tenantId: actor.tenant_id,
      title,
      location: "Karachi",
      requestedById: actor.id,
      status: "POSTED",
      jobContent: {
        summary:
          "A public role with complete responsibilities and benefits so applicants can make an informed decision before applying.",
        responsibilities: ["Build useful software"],
        requirements: ["Read the role"],
        benefits: ["Paid leave"],
        hiringProcess: ["Interview"],
        privateBudget: "DO_NOT_EXPORT",
      },
    },
  });
}
async function draftLink(email) {
  return tx(async (q) => {
    const candidate = await q.candidate.findFirstOrThrow({ where: { tenantId, email } });
    const draft = await q.applicationDraft.findFirstOrThrow({
      where: { tenantId, candidateId: candidate.id, requisitionId: job.id },
    });
    const message = await q.candidateCommunication.findFirstOrThrow({
      where: {
        tenantId,
        candidateId: candidate.id,
        context: { path: ["tokenHash"], equals: draft.tokenHash },
      },
    });
    const payload = JSON.parse(decryptString(message.encryptedPayload));
    return { draft, token: new URL(payload.data.draftUrl).hash.slice("#token=".length) };
  });
}
const receipt = (posting) => issueBoardReceipt({ tenantId, requisitionId: job.id, posting });
test("job-board publication and intake keep company and first-touch boundaries", async (t) => {
  await tx(async (q) => {
    recruiter = await q.employee.create({
      data: {
        tenant_id: tenantId,
        employee_code: "BOARD-" + randomUUID().toUpperCase().slice(0, 20),
        userId: 930001,
        first_name: "Fictional recruiter",
        work_email: randomUUID() + "@example.invalid",
        status: "Active",
        employement_status: "Active",
        employeeCategory: "EMPLOYEE",
      },
    });
    job = await makeJob(q, recruiter);
  });
  await t.test(
    "verified publication atomically creates the public and Indeed channels with immutable external identity",
    async () => {
      const result = await asRecruiter(() =>
        publication.publishRequisition({
          id: job.id,
          tenantId,
          postingChannels: ["CAREER_SITE", "LINKEDIN"],
        }),
      );
      assert.deepEqual(
        new Set(result.postings.map((p) => p.channel)),
        new Set(["CAREER_SITE", "INDEED", "LINKEDIN"]),
      );
      indeed = result.postings.find((p) => p.channel === "INDEED");
      linkedIn = result.postings.find((p) => p.channel === "LINKEDIN");
      assert.equal(indeed.channelRef, boardReference(tenantId, job.id, "INDEED"));
      assert.equal(indeed.postedById, recruiter.id);
      const replay = await asRecruiter(() =>
        publication.publishRequisition({
          id: job.id,
          tenantId,
          postingChannels: ["CAREER_SITE", "LINKEDIN"],
        }),
      );
      assert.equal(replay.published.length, 0);
      assert.equal(replay.postings.find((p) => p.channel === "INDEED").id, indeed.id);
    },
  );
  await t.test(
    "both provider documents parse as XML and expose no private job or candidate fields",
    async () => {
      for (const channel of ["INDEED", "LINKEDIN"]) {
        const xml = await publicAs(() => jobBoardFeed({ tenantId, channel }));
        const parse = spawnSync(
          "python3",
          [
            "-c",
            "import sys,xml.etree.ElementTree as E; r=E.fromstring(sys.stdin.read()); assert r.tag=='source'; assert len(r.findall('job'))==1",
          ],
          { input: xml, encoding: "utf8", timeout: 10000 },
        );
        assert.equal(parse.status, 0, parse.stderr);
        assert.ok(xml.includes("sourceReceipt="));
        assert.ok(!xml.includes("DO_NOT_EXPORT"));
        assert.ok(!xml.includes(recruiter.work_email));
      }
    },
  );
  await t.test(
    "apply redirects use only the approved company origin and live published identity",
    async () => {
      const target = new URL(
        await publicAs(() =>
          jobBoardApplyRedirect({ tenantId, requisitionId: job.id, channel: "INDEED" }),
        ),
      );
      assert.equal(target.origin, company.careersOrigin);
      assert.equal(target.pathname, "/jobs/" + job.id);
      assert.ok(target.searchParams.get("sourceReceipt"));
      await assert.rejects(
        publicAs(() =>
          jobBoardApplyRedirect({
            tenantId,
            requisitionId: "https://evil.invalid",
            channel: "INDEED",
          }),
        ),
        { status: 404 },
      );
    },
  );
  await t.test(
    "real HTTP routes pin the portal host, return XML, constrain redirects and enforce Redis limits",
    async () => {
      const redisUrl = new URL(process.env.REDIS_URL || "");
      if (
        redisUrl.hostname !== "127.0.0.1" ||
        redisUrl.port !== "6379" ||
        redisUrl.pathname !== "/15"
      )
        throw new Error("Use isolated Redis fixture database 15");
      const { default: Express } = await import("express");
      const { request: httpRequest } = await import("node:http");
      const { default: Redis } = await import("ioredis");
      const { default: router } = await import("../../src/routes/publicPortal.routes.js");
      const client = new Redis(redisUrl.href, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await client.connect();
      const app = Express();
      app.locals.recruitmentRateLimitClient = client;
      app.use("/public", router);
      const server = app.listen(0, "127.0.0.1");
      try {
        await new Promise((resolve, reject) => {
          server.once("listening", resolve);
          server.once("error", reject);
        });
        const origin = "http://127.0.0.1:" + server.address().port;
        const request = (path, host = new URL(company.careersOrigin).hostname) =>
          new Promise((resolve, reject) => {
            const req = httpRequest(origin + path, {
              headers: { host, "x-portal-tenant": tenantId },
            }, (res) => {
              const chunks = [];
              let bytes = 0;
              res.on("data", (chunk) => {
                bytes += chunk.length;
                if (bytes > 1024 * 1024) req.destroy(new Error("Fixture response exceeds bound"));
                else chunks.push(chunk);
              });
              res.on("error", reject);
              res.on("end", () => resolve({
                status: res.statusCode,
                headers: new Headers(res.headers),
                text: async () => Buffer.concat(chunks).toString("utf8"),
              }));
            });
            req.on("error", reject);
            req.setTimeout(5000, () => req.destroy(new Error("Fixture HTTP deadline")));
            req.end();
          });
        const unknown = await request(
          "/public/job-boards/indeed.xml",
          "unknown." + tenantId + ".example.invalid",
        );
        assert.equal(unknown.status, 404);
        await unknown.text();
        for (let i = 0; i < 6; i++) {
          const response = await request("/public/job-boards/indeed.xml");
          assert.equal(response.status, 200);
          assert.ok(response.headers.get("content-type").startsWith("application/xml"));
          assert.equal(response.headers.get("cache-control"), "no-store");
          assert.ok((await response.text()).includes("<source>"));
        }
        const limited = await request("/public/job-boards/indeed.xml");
        assert.equal(limited.status, 429);
        await limited.text();
        const redirected = await request(
          "/public/job-boards/indeed/jobs/" + job.id + "/apply?target=https://evil.invalid",
        );
        assert.equal(redirected.status, 302);
        assert.equal(new URL(redirected.headers.get("location")).origin, company.careersOrigin);
        await redirected.text();
      } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await client.quit();
      }
    },
  );
  await t.test(
    "another company cannot fetch the feed or use its signed source receipt",
    async () => {
      await assert.rejects(
        publicAs(() => jobBoardFeed({ tenantId: foreign, channel: "INDEED" }), foreign),
        { status: 404 },
      );
      assert.equal(
        await tx(
          (q) =>
            resolveJobBoardSource(q, {
              tenantId: foreign,
              requisitionId: job.id,
              receipt: receipt(indeed),
            }),
          foreign,
        ),
        "PORTAL",
      );
    },
  );
  await t.test(
    "Indeed refuses the entire feed when one public job lacks its channel row",
    async () => {
      const extra = await tx(async (q) => {
        const row = await makeJob(q, recruiter, "Unreconciled public role");
        await q.jobPosting.create({
          data: { tenantId, requisitionId: row.id, channel: "CAREER_SITE" },
        });
        return row;
      });
      await assert.rejects(
        publicAs(() => jobBoardFeed({ tenantId, channel: "INDEED" })),
        { status: 503 },
      );
      await asRecruiter(() =>
        publication.publishRequisition({ id: extra.id, tenantId, postingChannels: ["INDEED"] }),
      );
      const xml = await publicAs(() => jobBoardFeed({ tenantId, channel: "INDEED" }));
      assert.equal((xml.match(/<job>/g) || []).length, 2);
      await tx((q) =>
        q.jobRequisition.update({ where: { id: extra.id }, data: { closesAt: new Date(0) } }),
      );
      const closedXml = await publicAs(() => jobBoardFeed({ tenantId, channel: "INDEED" }));
      assert.equal((closedXml.match(/<job>/g) || []).length, 1);
    },
  );
  await t.test(
    "an opted-in employer cannot partially unpublish Indeed while its public role remains open",
    async () => {
      await assert.rejects(
        asRecruiter(() =>
          publication.unpublishPosting({ tenantId, postingId: indeed.id, reason: "EXPIRED" }),
        ),
        { status: 409, code: "HR-5313" },
      );
    },
  );
  await t.test(
    "a mailbox-owned draft retains its first validated source through recovery, edits and submission",
    async () => {
      const email = randomUUID() + "@example.invalid";
      await publicAs(() =>
        drafts.saveApplicationDraft({
          tenantId,
          requisitionId: job.id,
          email,
          body: { firstName: "Fictional", sourceReceipt: receipt(indeed) },
        }),
      );
      const first = await draftLink(email);
      assert.equal(first.draft.source, "INDEED");
      await publicAs(() =>
        drafts.saveApplicationDraft({
          tenantId,
          requisitionId: job.id,
          email,
          body: { firstName: "Overwriter", sourceReceipt: receipt(linkedIn) },
        }),
      );
      const recovered = await draftLink(email);
      assert.equal(recovered.draft.source, "INDEED");
      assert.notEqual(recovered.token, first.token);
      const view = await publicAs(() =>
        drafts.loadApplicationDraft({ tenantId, token: recovered.token }),
      );
      await publicAs(() =>
        drafts.updateApplicationDraft({
          tenantId,
          token: recovered.token,
          expectedUpdatedAt: view.updatedAt,
          body: {
            firstName: "Fictional",
            consent: true,
            policyVersion: "board-fixture-1",
            answers: {},
            source: "LINKEDIN",
          },
        }),
      );
      const result = await publicAs(() =>
        drafts.submitApplicationDraft({ tenantId, token: recovered.token }),
      );
      const app = await tx((q) =>
        q.application.findFirstOrThrow({ where: { tenantId, id: result.applicationId } }),
      );
      assert.equal(app.source, "INDEED");
      await assert.rejects(
        tx((q) => q.application.update({ where: { id: app.id }, data: { source: "LINKEDIN" } })),
      );
    },
  );
  await t.test("typed or forged source values never become attribution", async () => {
    const email = randomUUID() + "@example.invalid";
    const result = await publicAs(() =>
      submitPublicApplication({
        tenantId,
        requisitionId: job.id,
        body: {
          firstName: "Fictional",
          email,
          consent: true,
          policyVersion: "board-fixture-1",
          source: "INDEED",
          sourceReceipt: "forged",
        },
      }),
    );
    const app = await tx((q) =>
      q.application.findFirstOrThrow({ where: { tenantId, id: result.applicationId } }),
    );
    assert.equal(app.source, "PORTAL");
  });
  await t.test("a closed channel cannot start a newly attributed draft", async () => {
    await asRecruiter(() =>
      publication.unpublishPosting({ tenantId, postingId: linkedIn.id, reason: "EXPIRED" }),
    );
    assert.equal(
      await tx((q) =>
        resolveJobBoardSource(q, { tenantId, requisitionId: job.id, receipt: receipt(linkedIn) }),
      ),
      "PORTAL",
    );
    const xml = await publicAs(() => jobBoardFeed({ tenantId, channel: "LINKEDIN" }));
    assert.ok(!xml.includes("<job>"));
  });
  await t.test(
    "closed public roles disappear from every feed and old links cannot attribute new applications",
    async () => {
      await tx((q) =>
        q.jobRequisition.update({ where: { id: job.id }, data: { closesAt: new Date(0) } }),
      );
      const xml = await publicAs(() => jobBoardFeed({ tenantId, channel: "INDEED" }));
      assert.ok(!xml.includes("<job>"));
      assert.equal(
        await tx((q) =>
          resolveJobBoardSource(q, { tenantId, requisitionId: job.id, receipt: receipt(indeed) }),
        ),
        "PORTAL",
      );
    },
  );
});
test.after(() => db.$disconnect());
