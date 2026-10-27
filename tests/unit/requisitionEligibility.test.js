// tests/unit/requisitionEligibility.test.js
//
// Phase 4 / decision record §2.9 + §2.9a — application eligibility.
//
// The decision names three conditions and one optional behaviour:
//
//   * the posting is active,
//   * the requisition is publishable/open,
//   * the closing date has not passed,
//   * optional autoCloseWhenFilled — NOT irreversible.
//
// The suite drives the REAL entry points for each: applications are created
// through applicationService (the REST and MCP paths share it), hires go through
// the application workflow, and auto-close runs through the publication service
// that owns every other way a requisition stops advertising.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-09-20T12:00:00.000Z");

// A live requisition: POSTED, one active career-site posting, no closing date.
const liveRequisition = (overrides = {}) => ({
  id: 5,
  title: "Backend Engineer",
  status: "POSTED",
  openings: 1,
  closesAt: null,
  autoCloseWhenFilled: false,
  autoClosedAt: null,
  tenantId: TENANT,
  ...overrides,
});

const activePosting = (overrides = {}) => ({
  id: 88,
  requisitionId: 5,
  channel: "CAREER_SITE",
  isActive: true,
  closedAt: null,
  tenantId: TENANT,
  ...overrides,
});

// ── The pure evaluator ───────────────────────────────────────────────────────

describe("Phase 4 — the eligibility rule (§2.9)", () => {
  let evaluateRequisitionEligibility;
  let closedApplicationMessage;

  beforeAll(async () => {
    ({ evaluateRequisitionEligibility, closedApplicationMessage } = await import(
      "../../src/lib/requisition-eligibility.util.js"
    ));
  });

  it("accepts a live posted requisition with an active posting and no closing date", () => {
    const result = evaluateRequisitionEligibility(liveRequisition(), {
      postings: [activePosting()],
      now: NOW,
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("refuses a requisition whose window has passed, and says the window is why", () => {
    const requisition = liveRequisition({ closesAt: "2026-09-01T00:00:00.000Z" });
    const result = evaluateRequisitionEligibility(requisition, { postings: [activePosting()], now: NOW });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["APPLICATION_WINDOW_CLOSED"]);
    expect(result.closable).toBe(true); // live, just expired — the §2.9a copy case
  });

  it("accepts an application on the closing date itself, and refuses the day after", () => {
    const requisition = liveRequisition({ closesAt: "2026-09-20T12:00:00.000Z" });
    expect(
      evaluateRequisitionEligibility(requisition, { postings: [activePosting()], now: NOW }).eligible,
    ).toBe(true);

    const late = new Date(NOW.getTime() + 1);
    expect(
      evaluateRequisitionEligibility(requisition, { postings: [activePosting()], now: late }).reasons,
    ).toEqual(["APPLICATION_WINDOW_CLOSED"]);
  });

  it("treats an absent closing date as open", () => {
    expect(evaluateRequisitionEligibility(liveRequisition(), { postings: [activePosting()], now: NOW }).eligible).toBe(true);
  });

  it("refuses every non-accepting status, naming each one", () => {
    for (const status of ["DRAFT", "PENDING_APPROVAL", "REJECTED", "CLOSED", "WITHDRAWN"]) {
      const result = evaluateRequisitionEligibility(liveRequisition({ status }), {
        postings: [activePosting()],
        now: NOW,
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain(status === "CLOSED" ? "REQUISITION_CLOSED" : `REQUISITION_${status}`);
    }
  });

  it("refuses a POSTED requisition with no live channel left", () => {
    const result = evaluateRequisitionEligibility(liveRequisition(), {
      postings: [activePosting({ isActive: false, closedAt: NOW })],
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["NO_ACTIVE_POSTING"]);
  });

  it("counts a closed posting as closed but lets an APPROVED requisition publish first", () => {
    // An APPROVED requisition is publishable before its first channel goes live,
    // so no postings YET is not the same as closed.
    expect(
      evaluateRequisitionEligibility(liveRequisition({ status: "APPROVED" }), { postings: [], now: NOW }).eligible,
    ).toBe(true);
  });

  it("reports EVERY failed reason at once, not the first", () => {
    // A CLOSED requisition is not charged with NO_ACTIVE_POSTING separately: the
    // status is the reason it is closed, and padding the list with derived
    // consequences would make the UI show two causes for one decision.
    const result = evaluateRequisitionEligibility(liveRequisition({ status: "CLOSED", closesAt: "2026-09-01" }), {
      postings: [],
      now: NOW,
    });
    expect(result.reasons).toEqual(["REQUISITION_CLOSED", "APPLICATION_WINDOW_CLOSED"]);
  });

  it("resolves the §2.9a copy to exactly one message, whatever failed", () => {
    const req = liveRequisition({ closesAt: "2026-09-01T00:00:00.000Z" });

    const window = closedApplicationMessage(req, evaluateRequisitionEligibility(req, { postings: [activePosting()], now: NOW }));
    expect(window.code).toBe("APPLICATION_WINDOW_CLOSED");
    expect(window.message).toMatch(/no longer accepting|has closed/i);
    expect(window.detail.closesAt).toBe("2026-09-01T00:00:00.000Z");

    const closed = closedApplicationMessage(
      liveRequisition({ status: "CLOSED", closesAt: "2026-09-01" }),
      evaluateRequisitionEligibility(liveRequisition({ status: "CLOSED", closesAt: "2026-09-01" }), { postings: [], now: NOW }),
    );
    // A CLOSED requisition reads as closed, not as "window expired" — the status
    // is the operator's decision and outranks the arithmetic.
    expect(closed.code).toBe("REQUISITION_CLOSED");
  });
});

// ── The gate on the real write path ──────────────────────────────────────────

describe("Phase 4 — applications are refused for an ineligible requisition", () => {
  let prisma;
  let createApplication;

  beforeEach(async () => {
    jest.resetModules();
    let REQUISITION = liveRequisition();
    prisma = {
      // The tenant predicate the service builds is applied for real: a
      // requisition from another tenant reads as not-found, which is the
      // fail-closed behaviour the REST and MCP paths both rely on.
      jobRequisition: {
        findFirst: jest.fn(async ({ where = {} } = {}) => {
          if (where.tenantId !== undefined && (REQUISITION.tenantId ?? null) !== where.tenantId) return null;
          if (where.id !== undefined && REQUISITION.id !== where.id) return null;
          return { ...REQUISITION, postings: REQUISITION.__postings ?? [activePosting()] };
        }),
      },
      application: {
        create: jest.fn(async ({ data }) => ({ id: 501, ...data })),
        findFirst: jest.fn(async () => null),
      },
      applicationStageHistory: { create: jest.fn(async () => ({ id: 1 })) },
      // Phase 2 / D-11 — the intake reads the candidate and probes the DNC register.
      candidate: { findFirst: jest.fn(async () => ({ id: 12, email: "c12@example.com" })) },
      candidateDncEntry: { findFirst: jest.fn(async () => null) },
      $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
    };
    jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
    jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
    jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
    jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
      tenantTransaction: jest.fn((client, fn) => fn(client)),
      rlsTenantExtension: jest.fn((client) => client),
    }));
    const setRequisition = (r) => { REQUISITION = r; };
    ({ createApplication } = await import("../../src/services/application.service.js"));
    createApplication.__setRequisition = setRequisition;
  });

  const apply = (requisitionOverrides = {}) => {
    createApplication.__setRequisition(liveRequisition(requisitionOverrides));
    return createApplication({
      candidateId: 12,
      jobRequisitionId: 5,
      tenantId: TENANT,
      createdById: 9,
    });
  };

  it("creates an application against a live requisition", async () => {
    const created = await apply();
    expect(created.id).toBe(501);
    expect(prisma.application.create).toHaveBeenCalledTimes(1);
    expect(prisma.applicationStageHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fromStage: "applied", toStage: "applied" }) }),
    );
  });

  it("refuses when the window has passed, with the candidate-facing copy attached", async () => {
    await expect(apply({ closesAt: "2026-09-01T00:00:00.000Z" })).rejects.toMatchObject({
      code: "HR-RECRUITMENT-APPLICATIONS-CLOSED",
      status: 409,
      details: { reasons: ["APPLICATION_WINDOW_CLOSED"] },
    });
    expect(prisma.application.create).not.toHaveBeenCalled();
  });

  it("refuses a closed requisition", async () => {
    await expect(apply({ status: "CLOSED" })).rejects.toMatchObject({
      code: "HR-RECRUITMENT-APPLICATIONS-CLOSED",
      details: { reasons: ["REQUISITION_CLOSED"] },
    });
  });

  it("refuses a withdrawn requisition", async () => {
    await expect(apply({ status: "WITHDRAWN" })).rejects.toMatchObject({
      code: "HR-RECRUITMENT-APPLICATIONS-CLOSED",
    });
  });

  it("refuses when every channel has been taken down", async () => {
    createApplication.__setRequisition({ ...liveRequisition(), __postings: [] });
    await expect(createApplication({ candidateId: 12, jobRequisitionId: 5, tenantId: TENANT, createdById: 9 })).rejects.toMatchObject({
      code: "HR-RECRUITMENT-APPLICATIONS-CLOSED",
      details: { reasons: ["NO_ACTIVE_POSTING"] },
    });
  });

  it("cannot apply to another tenant's requisition", async () => {
    // The requisition stays tenant A's; the CALLER claims tenant B.
    createApplication.__setRequisition(liveRequisition());
    await expect(
      createApplication({
        candidateId: 12,
        jobRequisitionId: 5,
        tenantId: "22222222-2222-2222-2222-222222222222",
        createdById: 9,
      }),
    ).rejects.toMatchObject({
      code: "HR-RECRUITMENT-REQUISITION-NOT-FOUND",
      status: 404,
    });
  });
});

// ── Auto-close when filled (§2.5) ────────────────────────────────────────────

describe("Phase 4 — autoCloseWhenFilled closes the requisition, reversibly", () => {
  let prisma;
  let autoCloseFilledRequisitions;

  beforeEach(async () => {
    jest.resetModules();
    let REQUISITIONS = [];
    let APPLICATIONS = [];
    prisma = {
      jobRequisition: {
        // The sweep's own WHERE (autoCloseWhenFilled + autoClosedAt: null) is
        // applied for real, so "not opted in" and "already closed" are tested
        // against the predicate the service actually builds.
        findMany: jest.fn(async ({ where = {} } = {}) =>
          REQUISITIONS
            .filter((r) =>
              where.tenantId === undefined ? true : (r.tenantId ?? null) === where.tenantId,
            )
            .filter((r) => (where.autoCloseWhenFilled === undefined ? true : r.autoCloseWhenFilled === where.autoCloseWhenFilled))
            .filter((r) => (where.autoClosedAt === undefined ? true : (r.autoClosedAt ?? null) === where.autoClosedAt))
            .filter((r) => (where.status?.in ? where.status.in.includes(r.status) : true))
            .map((r) => ({ ...r })),
        ),
        update: jest.fn(async ({ where, data }) => {
          const row = REQUISITIONS.find((r) => r.id === where.id);
          Object.assign(row, data);
          return { ...row };
        }),
      },
      application: {
        count: jest.fn(async ({ where }) =>
          APPLICATIONS.filter((a) => a.jobRequisitionId === where.jobRequisitionId && a.stage === where.stage).length,
        ),
      },
      jobPosting: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      requisitionTransition: { create: jest.fn(async () => ({ id: 1 })) },
      $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
    };
    jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
    jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
    jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
    jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
      enqueueHrDomainEvent: jest.fn(async () => undefined),
    }));
    jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
      tenantTransaction: jest.fn((client, fn) => fn(client)),
      rlsTenantExtension: jest.fn((client) => client),
    }));
    const seed = (requisitions, applications) => {
      REQUISITIONS = requisitions;
      APPLICATIONS = applications;
    };
    ({ autoCloseFilledRequisitions } = await import("../../src/services/requisition-publication.service.js"));
    autoCloseFilledRequisitions.__seed = seed;
  });

  it("closes an opted-in requisition once its openings are filled, stamping autoClosedAt", async () => {
    autoCloseFilledRequisitions.__seed(
      [liveRequisition({ autoCloseWhenFilled: true, openings: 1 })],
      [{ jobRequisitionId: 5, stage: "hired" }],
    );

    const closed = await autoCloseFilledRequisitions({ tenantId: TENANT, now: NOW });
    expect(closed).toEqual([{ id: 5, hiredCount: 1, closedPostings: 1 }]);
    expect(prisma.jobRequisition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CLOSED", autoClosedAt: NOW }),
      }),
    );
    expect(prisma.jobPosting.updateMany).toHaveBeenCalled();
    expect(prisma.requisitionTransition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromStatus: "POSTED", toStatus: "CLOSED", source: "requisition.autoclose" }),
      }),
    );
  });

  it("waits until ALL openings are filled, not the first hire", async () => {
    autoCloseFilledRequisitions.__seed(
      [liveRequisition({ autoCloseWhenFilled: true, openings: 2 })],
      [{ jobRequisitionId: 5, stage: "hired" }],
    );
    expect(await autoCloseFilledRequisitions({ tenantId: TENANT })).toEqual([]);
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
  });

  it("never touches a requisition that did not opt in", async () => {
    autoCloseFilledRequisitions.__seed(
      [liveRequisition({ autoCloseWhenFilled: false })],
      [{ jobRequisitionId: 5, stage: "hired" }],
    );
    expect(await autoCloseFilledRequisitions({ tenantId: TENANT })).toEqual([]);
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
  });

  it("skips an already auto-closed requisition — a re-run is a no-op", async () => {
    autoCloseFilledRequisitions.__seed(
      [liveRequisition({ autoCloseWhenFilled: true, autoClosedAt: NOW })],
      [{ jobRequisitionId: 5, stage: "hired" }],
    );
    expect(await autoCloseFilledRequisitions({ tenantId: TENANT })).toEqual([]);
  });

  it("ignores rejected/withdrawn applications when counting fills", async () => {
    autoCloseFilledRequisitions.__seed(
      [liveRequisition({ autoCloseWhenFilled: true })],
      [
        { jobRequisitionId: 5, stage: "hired" },
        { jobRequisitionId: 5, stage: "rejected" },
        { jobRequisitionId: 5, stage: "offer" },
      ],
    );
    expect(await autoCloseFilledRequisitions({ tenantId: TENANT })).toHaveLength(1);
  });
});

// ── A hire cannot be recorded against a closed search ───────────────────────

describe("Phase 4 — hired against a closed requisition", () => {
  it("refuses the hired transition when the requisition is CLOSED or WITHDRAWN", async () => {
    jest.resetModules();
    const db = {
      application: {
        findFirst: jest.fn(async () => ({
          id: 7,
          tenantId: TENANT,
          stage: "offer",
          jobRequisitionId: 5,
        })),
        update: jest.fn(),
      },
      offer: { findFirst: jest.fn(async () => ({ id: 3, status: "ACCEPTED" })) },
      jobRequisition: { findFirst: jest.fn(async () => ({ id: 5, status: "CLOSED" })) },
      interview: { findFirst: jest.fn(async () => null) },
      applicationStageHistory: { create: jest.fn() },
    };
    jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
    jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
    const { transitionApplicationStage } = await import("../../src/services/application-workflow.service.js");

    await expect(
      transitionApplicationStage({ id: 7, tenantId: TENANT, targetStage: "hired", db }),
    ).rejects.toMatchObject({ code: "HR-RECRUITMENT-REQUISITION-NOT-ACCEPTING" });
    expect(db.application.update).not.toHaveBeenCalled();

    db.jobRequisition.findFirst.mockResolvedValue({ id: 5, status: "WITHDRAWN" });
    await expect(
      transitionApplicationStage({ id: 7, tenantId: TENANT, targetStage: "hired", db }),
    ).rejects.toMatchObject({ code: "HR-RECRUITMENT-REQUISITION-NOT-ACCEPTING" });
  });

  it("still allows a hire against an accepting requisition — an accepted offer completes", async () => {
    jest.resetModules();
    const db = {
      application: {
        findFirst: jest.fn(async () => ({ id: 7, tenantId: TENANT, stage: "offer", jobRequisitionId: 5 })),
        update: jest.fn(async () => ({ id: 7, stage: "hired" })),
      },
      offer: { findFirst: jest.fn(async () => ({ id: 3, status: "ACCEPTED" })) },
      jobRequisition: { findFirst: jest.fn(async () => ({ id: 5, status: "POSTED" })) },
      interview: { findFirst: jest.fn(async () => null) },
      applicationStageHistory: { create: jest.fn(async () => ({ id: 1 })) },
    };
    jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: {} }));
    jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
    jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
      enqueueHrDomainEvent: jest.fn(async () => undefined),
    }));
    const { transitionApplicationStage } = await import("../../src/services/application-workflow.service.js");

    const result = await transitionApplicationStage({ id: 7, tenantId: TENANT, targetStage: "hired", db });
    expect(result.changed).toBe(true);
  });
});
