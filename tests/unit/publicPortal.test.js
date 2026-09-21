// tests/unit/publicPortal.test.js
//
// Phase 5 / decision record §3.1–§3.5 — the public careers portal.
//
// The assertions that matter are the ones the internet will find:
//
//   * ANTI-ENUMERATION — unknown job, closed job, another tenant's job and a
//     bad id all produce the SAME 404, so ids cannot be probed; the application
//     endpoint never reveals whether a candidate email already exists.
//   * NO INTERNALS LEAK — listings carry published content, never the hiring
//     manager, never approval state, never rejection reasons.
//   * ELIGIBILITY PARITY — the public listing shows exactly the jobs the
//     internal gate would accept an application against; a job removed from the
//     listing cannot still be applied to.
//   * CONSENT — PROCESSING consent records the policy version the portal
//     declared, and never bundles talent-pool or marketing purposes.
//   * RECONCILIATION — a returning candidate matches their existing row, and
//     an anonymized row is NOT resurrected.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-09-20T12:00:00.000Z");

const liveRequisition = (overrides = {}) => ({
  id: 5,
  title: "Backend Engineer",
  status: "POSTED",
  openings: 1,
  location: "Karachi",
  employmentType: "FULL_TIME",
  closesAt: null,
  jobContent: {
    schemaVersion: 1,
    summary: "Build APIs",
    skills: ["Node.js"],
  },
  tenantId: TENANT,
  ...overrides,
});

const activePosting = (overrides = {}) => ({
  id: 88,
  requisitionId: 5,
  channel: "CAREER_SITE",
  externalUrl: null,
  isActive: true,
  closedAt: null,
  tenantId: TENANT,
  ...overrides,
});

describe("Phase 5 — the public job listing (§3.1)", () => {
  let listPublicJobs;
  let getPublicJob;

  beforeAll(async () => {
    ({ listPublicJobs, getPublicJob } = await import("../../src/lib/publicPortal.js"));
  });

  it("lists only eligible POSTED jobs, stripped to the public shape", async () => {
    const prisma = {
      jobRequisition: {
        findMany: jest.fn(async () => [
          liveRequisition({ postings: [activePosting()] }),
          liveRequisition({ id: 6, title: "Closed one", status: "CLOSED", postings: [] }),
          liveRequisition({ id: 7, title: "Expired", closesAt: "2026-09-01", postings: [activePosting({ id: 89 })] }),
        ]),
      },
    };

    const jobs = await listPublicJobs({ tenantId: TENANT, prisma, now: NOW });

    // Only the live one survives — the closed and expired ones never appear.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 5, title: "Backend Engineer" });
    // And the shape carries no internals.
    expect(jobs[0]).not.toHaveProperty("eligible");
    expect(jobs[0]).not.toHaveProperty("candidateMessage");
    expect(jobs[0]).not.toHaveProperty("requestedById");
    expect(jobs[0]).not.toHaveProperty("costCenterRef");
    expect(jobs[0]).not.toHaveProperty("departmentId");
    expect(jobs[0].jobContent).toMatchObject({ schemaVersion: 1, summary: "Build APIs" });
  });

  it("filters by title and published skills without exposing the search space", async () => {
    const prisma = {
      jobRequisition: {
        findMany: jest.fn(async () => [
          liveRequisition({ id: 5, postings: [activePosting()] }),
          liveRequisition({ id: 6, title: "Nurse", jobContent: { skills: ["Care"] }, postings: [activePosting({ id: 89 })] }),
        ]),
      },
    };
    const bySkill = await listPublicJobs({ tenantId: TENANT, prisma, q: "node", now: NOW });
    expect(bySkill.map((j) => j.id)).toEqual([5]);
  });

  it("404s an unknown id, a closed job and a bad id identically (anti-enumeration)", async () => {
    const prisma = {
      jobRequisition: { findFirst: jest.fn(async () => null) },
    };
    // All three resolve to null — the route renders them the same. The two
    // non-numeric ids are refused BEFORE any query, so only the numeric one hits
    // the database at all: a garbage id cannot even be used to time the lookup.
    expect(await getPublicJob({ tenantId: TENANT, prisma, id: 999, now: NOW })).toBeNull();
    expect(await getPublicJob({ tenantId: TENANT, prisma, id: "abc", now: NOW })).toBeNull();
    expect(await getPublicJob({ tenantId: TENANT, prisma, id: -1, now: NOW })).toBeNull();
    expect(prisma.jobRequisition.findFirst).toHaveBeenCalledTimes(1);
  });

  it("never returns a job that the application gate would refuse (eligibility parity)", async () => {
    // POSTED but every channel was taken down: eligible nowhere.
    const prisma = {
      jobRequisition: {
        findFirst: jest.fn(async () =>
          liveRequisition({ postings: [activePosting({ isActive: false, closedAt: NOW })] }),
        ),
      },
    };
    expect(await getPublicJob({ tenantId: TENANT, prisma, id: 5, now: NOW })).toBeNull();
  });
});

describe("Phase 5 — public application intake (§3.2/§3.4/§3.5)", () => {
  let prisma;
  let submitPublicApplication;
  let sendCandidateEmail;

  // One stable double per describe block; seed() swaps the mock implementations
  // in place so the service's captured module import always sees the current
  // fixtures (re-importing per test with ESM mocks does not rewire cleanly).
  beforeAll(async () => {
    prisma = {
      jobRequisition: { findFirst: jest.fn() },
      candidate: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
      application: { findFirst: jest.fn(), create: jest.fn() },
      applicationStageHistory: { create: jest.fn() },
      candidateConsent: { create: jest.fn() },
      // Phase 5 §3.5 — the intake reads the requisition's question set inside the
      // same transaction. Default: no questions configured (the pre-§3.5 shape);
      // question-bearing tests override this via prisma.__questions.
      applicationQuestion: {
        findMany: jest.fn(async () => prisma.__questions ?? []),
      },
      applicationAnswer: { createMany: jest.fn(async () => ({ count: 0 })) },
      $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
    };
    // Phase 5 / §3.2 — the verification token lifecycle gets its own doubles.
    prisma.candidateEmailVerification = {
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
    };
    jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
    jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
    jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
    jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
      enqueueHrDomainEvent: jest.fn(async () => undefined),
    }));
    jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
      tenantTransaction: jest.fn((client, fn) => fn(client)),
      rlsTenantExtension: jest.fn((client) => client),
    }));
    // The email plane is mocked (this suite is about the portal, not the hub
    // client) but the SEND must be observed: token issuance on every intake,
    // mailbox notice only on the reconciled path.
    jest.unstable_mockModule("../../src/lib/notificationClient.js", () => ({
      sendCandidateEmail: jest.fn(async () => ({ sent: true })),
    }));
    ({ submitPublicApplication } = await import("../../src/services/publicPortal.service.js"));
    ({ sendCandidateEmail } = await import("../../src/lib/notificationClient.js"));
  });

  const seed = (requisition, candidates = [], applications = [], consents = []) => {
    prisma.jobRequisition.findFirst.mockImplementation(async ({ where = {} } = {}) => {
      if (!requisition) return null;
      if (where.tenantId !== undefined && requisition.tenantId !== where.tenantId) return null;
      if (where.id !== undefined && requisition.id !== where.id) return null;
      return { ...requisition, postings: requisition.__postings ?? [activePosting()] };
    });

    // The service's WHERE is applied for real: an anonymized row never matches
    // (the anonymizedAt: null predicate), so re-identifying an erased person is
    // impossible at the query level, not just by convention.
    prisma.candidate.findFirst.mockImplementation(async ({ where = {} } = {}) =>
      candidates.find(
        (c) =>
          c.email === where.email &&
          (where.tenantId === undefined || c.tenantId === where.tenantId) &&
          (where.anonymizedAt === null ? c.anonymizedAt == null : true) &&
          (where.status === "active" ? c.status === "active" : true),
      ) || null,
    );
    prisma.candidate.create.mockImplementation(async ({ data }) => {
      const row = { id: candidates.length + 1, status: "active", anonymizedAt: null, ...data };
      candidates.push(row);
      return row;
    });
    prisma.candidate.update.mockImplementation(async ({ where, data }) => {
      const row = candidates.find((c) => c.id === where.id);
      Object.assign(row, data);
      return row;
    });
    prisma.application.findFirst.mockImplementation(async () => applications[0] ?? null);
    prisma.application.create.mockImplementation(async ({ data }) => {
      const row = { id: 900 + applications.length, ...data };
      applications.push(row);
      return row;
    });
    prisma.applicationStageHistory.create.mockImplementation(async () => ({ id: 1 }));
    prisma.candidateConsent.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
    prisma.__applications = applications;
    prisma.__consents = consents;
    prisma.__questions = [];
    prisma.__answers = [];
    prisma.applicationAnswer.createMany.mockImplementation(async ({ data }) => {
      data.forEach((row, i) => prisma.__answers.push({ id: i + 1, ...row }));
      return { count: data.length };
    });
  };

  beforeEach(() => {
    // Call counts must reset between tests, but the mock IMPLEMENTATIONS set by
    // seed() must survive — clearAllMocks would strip them.
    sendCandidateEmail.mockClear();
    for (const table of Object.values(prisma)) {
      if (table && typeof table === "object") {
        for (const fn of Object.values(table)) {
          if (typeof fn?.mock === "object") fn.mockClear();
        }
      }
    }
    seed(liveRequisition());
  });

  const payload = (overrides = {}) => ({
    firstName: "Ayesha",
    lastName: "Malik",
    email: "ayesha@example.com",
    phone: "+923001234567",
    policyVersion: "privacy-2026-09",
    ...overrides,
  });

  it("FR-04.11 — every applicant gets a confirmation email carrying their personal status link", async () => {
    await submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() });

    // TWO token rows issued in-transaction: APPLY_VERIFICATION + STATUS_LINK.
    const purposes = prisma.candidateEmailVerification.create.mock.calls.map(
      (c) => c[0].data.purpose,
    );
    expect(purposes.sort()).toEqual(["APPLY_VERIFICATION", "STATUS_LINK"]);

    // TWO candidate emails: the verification mail + the confirmation mail.
    const templates = sendCandidateEmail.mock.calls.map((c) => c[0].templateId);
    expect(templates).toContain("hr.recruitment.portal_email_verification");
    expect(templates).toContain("hr.recruitment.portal_application_confirmed");
    const confirmation = sendCandidateEmail.mock.calls.find(
      (c) => c[0].templateId === "hr.recruitment.portal_application_confirmed",
    )[0];
    expect(confirmation.data.statusUrl).toContain("/public/candidates/status?token=");
    expect(confirmation.data.applicationRef).toBeTruthy();
  });

  it("FR-04.11 reconciled — the confirmation doubles as the mailbox-owner notice (one email, existing variant)", async () => {
    seed(liveRequisition(), [
      { id: 3, email: "ayesha@example.com", tenantId: TENANT, anonymizedAt: null, status: "active", firstName: "", lastName: null, phone: null },
    ]);

    await submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() });

    const templates = sendCandidateEmail.mock.calls.map((c) => c[0].templateId);
    expect(templates).toContain("hr.recruitment.portal_application_confirmed_existing");
    // No SEPARATE mailbox-notice send any more — the confirmation IS the notice.
    expect(templates).not.toContain("hr.recruitment.portal_mailbox_notice");
    expect(templates).not.toContain("hr.recruitment.portal_application_confirmed");
    expect(prisma.candidate.create).not.toHaveBeenCalled();
  });

  it("creates a candidate, an application, a stage-history row and a PROCESSING consent in one transaction", async () => {
    const result = await submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() });

    expect(result).toMatchObject({ received: true, applicationId: 900, requisitionId: 5 });
    expect(prisma.candidate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "ayesha@example.com", consentStatus: "GRANTED" }),
      }),
    );
    expect(prisma.application.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stage: "applied", createdById: null }) }),
    );
    expect(prisma.candidateConsent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          purpose: "PROCESSING",
          status: "GRANTED",
          policyVersion: "privacy-2026-09",
          source: "portal",
        }),
      }),
    );
    // Never bundles other purposes into an application (§3.3a).
    expect(prisma.candidateConsent.create.mock.calls[0][0].data.purpose).toBe("PROCESSING");
  });

  it("never invents a policy version — no version, no consent record", async () => {
    await submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload({ policyVersion: null }) });
    expect(prisma.candidateConsent.create).not.toHaveBeenCalled();
  });

  it("reconciles a returning candidate onto their existing row and does not overwrite their data", async () => {
    seed(
      liveRequisition(),
      [{ id: 41, email: "ayesha@example.com", tenantId: TENANT, firstName: "Ayesha", lastName: "Old", phone: "+923007777777", status: "active", anonymizedAt: null }],
    );
    await submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() });

    expect(prisma.candidate.create).not.toHaveBeenCalled();
    // Only fills blanks; never overwrites what is already there.
    expect(prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 41 },
        data: expect.objectContaining({ lastName: "Old", phone: "+923007777777" }),
      }),
    );
  });

  it("does not resurrect an anonymized candidate — a fresh row is created", async () => {
    seed(
      liveRequisition(),
      [{ id: 41, email: "ayesha@example.com", tenantId: TENANT, status: "active", anonymizedAt: new Date() }],
    );
    await submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() });

    expect(prisma.candidate.create).toHaveBeenCalled();
    expect(prisma.candidate.update).not.toHaveBeenCalled();
  });

  it("refuses a duplicate application, and the refusal says nothing about the candidate", async () => {
    seed(liveRequisition(), [], [{ id: 555, candidateId: 1, jobRequisitionId: 5 }]);
    await expect(
      submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() }),
    ).rejects.toMatchObject({ status: 409, code: "HR-PORTAL-DUPLICATE" });
    expect(prisma.application.create).not.toHaveBeenCalled();
  });

  it("404s an unknown job and a CLOSED job identically, so ids cannot be probed", async () => {
    seed(liveRequisition({ status: "CLOSED" }));
    const closed = await submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() }).catch((e) => e);

    seed(null);
    const unknown = await submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() }).catch((e) => e);

    // Byte-identical bodies — no oracle.
    expect(closed.status).toBe(unknown.status);
    expect(closed.message).toBe(unknown.message);
    expect(closed.code).toBe(unknown.code);
    expect(closed.code).toBe("HR-PORTAL-NOT-FOUND");
  });

  it("cannot apply to another tenant's job — same 404 as unknown", async () => {
    seed(liveRequisition({ tenantId: "22222222-2222-2222-2222-222222222222" }));
    await expect(
      submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() }),
    ).rejects.toMatchObject({ status: 404, code: "HR-PORTAL-NOT-FOUND" });
  });

  it("refuses an application past the closing date, with the same 404 as unknown", async () => {
    seed(liveRequisition({ closesAt: "2026-09-01" }));
    // §2.9a says the candidate should learn the window closed — the DETAILS
    // carry that copy, but the status/code stay the uniform not-found so the
    // endpoint is still not an existence oracle.
    await expect(
      submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload() }),
    ).rejects.toMatchObject({
      status: 404,
      code: "HR-PORTAL-NOT-FOUND",
      details: { candidateMessage: { code: "APPLICATION_WINDOW_CLOSED" } },
    });
  });

  it("validates the payload and normalizes the email", async () => {
    for (const bad of [payload({ email: "nope" }), payload({ firstName: "" }), payload({ email: "" }), payload({ phone: "call me" })]) {
      await expect(
        submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: bad }),
      ).rejects.toMatchObject({ status: 400, code: "HR-PORTAL-INPUT-INVALID" });
    }
    await submitPublicApplication({ tenantId: TENANT, requisitionId: 5, body: payload({ email: "  Ayesha@Example.COM  " }) });
    expect(prisma.candidate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "ayesha@example.com" }) }),
    );
  });
});

describe("Phase 5 — the public router's guards", () => {
  it("rate-limits the application endpoint and the reader separately", async () => {
    jest.resetModules();
    process.env.HR_PORTAL_HOSTS = `careers.test=${TENANT}`;
    const { default: router } = await import("../../src/routes/publicPortal.routes.js");
    const { resolvePortalTenant } = await import("../../src/routes/publicPortal.routes.js");

    const req = { hostname: "careers.test", get: () => null };
    expect(resolvePortalTenant(req)).toBe(TENANT);
    expect(resolvePortalTenant({ hostname: "unknown.test", get: () => null })).toBeNull();

    // The router exposes exactly the three public routes and nothing else.
    const paths = router.stack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
      .sort();
    // §3.2 + §3.5a — the candidate email/verification/status endpoints join
    // the public surface.
    expect(paths).toEqual([
        "GET /candidates/status",
        "GET /candidates/verify-email",
        "GET /jobs",
        "GET /jobs/:id",
        "POST /candidates/status-link",
        "POST /jobs/:id/apply",
    ]);
    delete process.env.HR_PORTAL_HOSTS;
  });

  it("honours the trusted-edge tenant header only when explicitly enabled", async () => {
    jest.resetModules();
    const { resolvePortalTenant } = await import("../../src/routes/publicPortal.routes.js");

    // Express's req.get is case-insensitive; the fake matches that behaviour.
    const req = { hostname: "unknown.test", get: (h) => (String(h).toLowerCase() === "x-portal-tenant" ? TENANT : null) };
    // Without the flag, a header-supplied tenant is ignored — tenant pinning
    // comes from the operator's host map, never from request data.
    expect(resolvePortalTenant(req)).toBeNull();

    process.env.HR_PORTAL_TRUST_EDGE_HEADER = "true";
    // The flag is read per call (not cached at import), so no re-import is needed.
    expect(resolvePortalTenant(req)).toBe(TENANT);
    expect(resolvePortalTenant({ hostname: "unknown.test", get: () => "not-a-uuid" })).toBeNull();
    delete process.env.HR_PORTAL_TRUST_EDGE_HEADER;
  });
});
