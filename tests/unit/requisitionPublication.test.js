// tests/unit/requisitionPublication.test.js
//
// Phase 4 / decision record §2.4 + §2.4a — publication channels and withdrawal.
//
// The three operations are tested through their REAL entry points rather than
// through the helpers, because the decision is about behaviour an operator sees:
// publishing to a channel, taking ONE channel down without ending the search, and
// withdrawing the requisition so that nothing is left advertised.
//
// The assertions that matter most:
//
//   * publishing an ADDITIONAL channel must not append a second POSTED transition
//     (the history would claim the requisition was published twice),
//   * unpublishing a channel must leave the requisition POSTED,
//   * withdrawal must close EVERY active posting in the same unit of work, and
//   * CLOSE — from any of the three surfaces that can do it — must close postings
//     too, or \"CLOSED\" would mean two different things depending on the endpoint.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

// A complete (Phase 2.2) requisition, so a refusal in these tests can never be the
// mandatory-field gate leaking in.
const baseRequisition = (overrides = {}) => ({
  id: 5,
  title: "Backend Engineer",
  departmentId: 3,
  location: "Karachi",
  employmentType: "FULL_TIME",
  openings: 1,
  requestedById: 7,
  hiringReason: "NEW_HIRE",
  costCenterRef: "CC-100",
  status: "APPROVED",
  tenantId: TENANT,
  ...overrides,
});

// Tenant-scoped in-memory tables. The tenant predicate the services build is
// actually applied, so "cannot see another tenant's posting" is a real assertion
// rather than a mock artefact.
let REQUISITIONS = [];
let POSTINGS = [];
let nextPostingId = 1;

const matchesPosting = (posting, where = {}) => {
  if (where.id !== undefined && typeof where.id === "object") {
    if (where.id.not !== undefined && posting.id === where.id.not) return false;
  } else if (where.id !== undefined && posting.id !== where.id) return false;
  if (where.tenantId !== undefined && (posting.tenantId ?? null) !== where.tenantId) return false;
  if (where.requisitionId !== undefined && posting.requisitionId !== where.requisitionId) return false;
  if (where.channel !== undefined && posting.channel !== where.channel) return false;
  if (where.isActive !== undefined && posting.isActive !== where.isActive) return false;
  return true;
};

const prisma = {
  $queryRawUnsafe: jest.fn(async()=>[{id:5}]),
  jobRequisition: {
    // A COPY, like Prisma: the service reads the requisition once and later writes
    // it, and a shared reference would make the pre-write status unreadable — the
    // history row would then record the POST-write status as its "from" side and
    // the test would pass against behaviour no real driver has.
    findFirst: jest.fn(async ({ where = {} } = {}) => {
      const row = REQUISITIONS.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.tenantId === undefined || (r.tenantId ?? null) === where.tenantId),
      );
      return row ? { ...row } : null;
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = REQUISITIONS.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where = {}, data = {} }) => {
      const row = REQUISITIONS.find(
        (r) => r.id === where.id && (where.tenantId === undefined || r.tenantId === where.tenantId),
      );
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    findMany: jest.fn(async () => []),
  },
  jobPosting: {
    findFirst: jest.fn(async ({ where = {} } = {}) =>
      POSTINGS.filter((p) => matchesPosting(p, where)).sort((a, b) => b.id - a.id)[0] || null,
    ),
    findMany: jest.fn(async ({ where = {} } = {}) =>
      POSTINGS.filter((p) => matchesPosting(p, where)),
    ),
    create: jest.fn(async ({ data }) => {
      const row = { id: nextPostingId++, channelRef: null, closedAt: null, closeReason: null, closedById: null, postedById: null, ...data };
      POSTINGS.push(row);
      return row;
    }),
    updateMany: jest.fn(async ({ where = {}, data = {} }) => {
      const rows = POSTINGS.filter((p) => matchesPosting(p, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    }),
  },
  requisitionApproval: { create: jest.fn(async () => ({ id: 1 })), findMany: jest.fn(async () => []) },
  requisitionApprovalRule: { findMany: jest.fn(async () => []) },
  requisitionTransition: { create: jest.fn(async () => ({ id: 1 })) },
  recruitmentHiringFreeze: { findFirst: jest.fn(async () => null) },
  businessUnit: { findMany: jest.fn(async () => []) },
  $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
  $executeRaw: jest.fn(async () => 1),
};

jest.unstable_mockModule("../../src/services/recruitmentActor.service.js",()=>({requireRecruitmentActor:jest.fn(async()=>({who:{id:9},scope:{level:'ORG',unrestricted:true,employeeId:9}}))}));
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/rbac.client.js", () => ({
  getDepartmentById: jest.fn(async () => null),
  listDepartments: jest.fn(async () => []),
  createRbacSystemAccount: jest.fn(async () => ({ ok: false })),
}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
  enqueueHrDomainEvent: jest.fn(async () => undefined),
}));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((client, fn) => fn(client)),
  rlsTenantExtension: jest.fn((client) => client),
}));

const {
  publishRequisition,
  unpublishPosting,
  withdrawRequisition,
  listRequisitionPostings,
  closeActivePostingsForRequisition,
} = await import("../../src/services/requisitionPublication.service.js");
const { closeRequisition } = await import("../../src/services/requisitionMgmt.service.js");
const { updateRequisition } = await import("../../src/services/requisition.service.js");
const {
  PUBLICATION_CHANNELS,
  POSTING_CLOSE_REASONS,
  WITHDRAWAL_REASONS,
  normalizeChannelPublication,
  normalizeChannelList,
  isPostingOpen,
  assertPublishableStatus,
} = await import("../../src/lib/requisitionPublication.js");
const { assertRequisitionTransition } = await import("../../src/services/requisitionWorkflow.service.js");
const { requisitionClosedEvent } = await import("../../src/services/hrEvents.js");
const { enqueueHrDomainEvent } = await import("../../src/services/hrDomainEvent.service.js");

const transitionRows = () => prisma.requisitionTransition.create.mock.calls.map(([arg]) => arg.data);
const activePostings = () => POSTINGS.filter((p) => p.isActive);

const priorAgencyFlag = process.env.HR_RECRUITMENT_AGENCY;
afterEach(() => {
  if (priorAgencyFlag === undefined) delete process.env.HR_RECRUITMENT_AGENCY;
  else process.env.HR_RECRUITMENT_AGENCY = priorAgencyFlag;
});
beforeEach(() => {
  process.env.HR_RECRUITMENT_AGENCY = "on";
  jest.clearAllMocks();
  REQUISITIONS = [baseRequisition()];
  POSTINGS = [];
  nextPostingId = 1;
  prisma.jobRequisition.findMany.mockResolvedValue([]);
  prisma.jobRequisition.updateMany.mockImplementation(async ({ where = {}, data = {} }) => {
    const row = REQUISITIONS.find(
      (r) => r.id === where.id && (where.tenantId === undefined || r.tenantId === where.tenantId),
    );
    if (!row) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  prisma.requisitionTransition.create.mockResolvedValue({ id: 1 });
  prisma.requisitionApproval.findMany.mockResolvedValue([]);
  prisma.requisitionApprovalRule.findMany.mockResolvedValue([]);
  prisma.recruitmentHiringFreeze.findFirst.mockResolvedValue(null);
});

describe("Phase 4 — the channel vocabulary (§2.4)", () => {
  it("requires a URL for every externally hosted channel and accepts the career site without one", () => {
    expect(normalizeChannelPublication("CAREER_SITE")).toMatchObject({ channel: "CAREER_SITE", externalUrl: null });
    expect(() => normalizeChannelPublication("LINKEDIN")).toThrow(/externalUrl is required/i);
    expect(normalizeChannelPublication("LINKEDIN", { externalUrl: "https://linkedin.com/jobs/1" })).toMatchObject({
      channel: "LINKEDIN",
      externalUrl: "https://linkedin.com/jobs/1",
    });
  });

  it("refuses a URL nobody could follow, because it ends up on the public page", () => {
    expect(() => normalizeChannelPublication("LINKEDIN", { externalUrl: "linkedin" })).toThrow(/absolute http\(s\) URL/i);
    expect(() => normalizeChannelPublication("LINKEDIN", { externalUrl: "ftp://x.test/j" })).toThrow(/absolute http\(s\) URL/i);
  });

  it("refuses an unknown channel rather than storing free text", () => {
    expect(() => normalizeChannelPublication("FACEBOOK")).toThrow(/channel must be one of/i);
    expect(PUBLICATION_CHANNELS).not.toContain("FACEBOOK");
  });

  it("defaults to the career site and de-duplicates the channel list", () => {
    expect(normalizeChannelList(undefined).map((c) => c.channel)).toEqual(["CAREER_SITE"]);
    expect(
      normalizeChannelList(["LINKEDIN", "LINKEDIN", { channel: "INDEED", externalUrl: "https://indeed.test/1" }], {
        externalUrl: "https://linkedin.com/jobs/1",
      }).map((c) => c.channel),
    ).toEqual(["LINKEDIN", "INDEED"]);
  });

  it("only allows publishing from APPROVED or POSTED", () => {
    expect(assertPublishableStatus("approved")).toBe("APPROVED");
    expect(assertPublishableStatus("POSTED")).toBe("POSTED");
    for (const status of ["DRAFT", "PENDING_APPROVAL", "REJECTED", "CLOSED", "WITHDRAWN"]) {
      expect(() => assertPublishableStatus(status)).toThrow(/APPROVED or already-POSTED/i);
    }
  });

  it("reads an active posting with no close timestamp as open, and a closed one as closed", () => {
    expect(isPostingOpen({ isActive: true, closedAt: null })).toBe(true);
    expect(isPostingOpen({ isActive: false, closedAt: new Date() })).toBe(false);
    expect(isPostingOpen({ isActive: true, closedAt: new Date() })).toBe(false);
    expect(isPostingOpen(null)).toBe(false);
  });
});

describe("Phase 4 — publishing to a channel (§2.4)", () => {
  it("publishes to the built-in career site by default, moving APPROVED → POSTED", async () => {
    const result = await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });

    expect(result.published).toEqual(["CAREER_SITE"]);
    expect(result.unchanged).toEqual([]);
    expect(result.requisition.status).toBe("POSTED");
    expect(POSTINGS).toHaveLength(1);
    expect(POSTINGS[0]).toMatchObject({ channel: "CAREER_SITE", isActive: true, postedById: 9, tenantId: TENANT });

    const rows = transitionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toStatus: "POSTED", fromStatus: "APPROVED", source: "requisition.post", actorId: 9 });
  });

  it("records a per-channel posting with its URL and the channel's own reference", async () => {
    const result = await publishRequisition({
      id: 5,
      postingChannels: [{ channel: "AGENCY", externalUrl: "https://agency.test/job/9", channelRef: "AG-9" }],
      actorId: 9,
      tenantId: TENANT,
    });

    expect(result.published).toEqual(["AGENCY"]);
    expect(POSTINGS[0]).toMatchObject({
      channel: "AGENCY",
      externalUrl: "https://agency.test/job/9",
      channelRef: "AG-9",
    });
    // The notice carries the only public link, and it is scoped to its channel.
    expect(enqueueHrDomainEvent.mock.calls[0][1].payload).toMatchObject({
      requisitionId: "5",
      status: "POSTED",
      externalUrl: "https://agency.test/job/9",
    });
  });

  it("refuses to publish a requisition that was never approved", async () => {
    REQUISITIONS = [baseRequisition({ status: "DRAFT" })];
    await expect(publishRequisition({ id: 5, tenantId: TENANT })).rejects.toThrow(/APPROVED or already-POSTED/i);
    expect(POSTINGS).toHaveLength(0);
  });

  it("adds an ADDITIONAL channel without re-recording the publication", async () => {
    await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });
    const second = await publishRequisition({
      id: 5,
      postingChannels: ["LINKEDIN"],
      externalUrl: "https://linkedin.com/jobs/1",
      actorId: 9,
      tenantId: TENANT,
    });

    expect(second.requisition.status).toBe("POSTED");
    expect(second.published).toEqual(["LINKEDIN"]);
    expect(activePostings().map((p) => p.channel).sort()).toEqual(["CAREER_SITE", "LINKEDIN"]);
    // ONE publication, one transition. A second POSTED row would make the history
    // claim the requisition was published twice on the same day.
    expect(transitionRows()).toHaveLength(1);
  });

  it("leaves an already-active channel alone instead of duplicating it", async () => {
    await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });
    const again = await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });

    expect(again.published).toEqual([]);
    expect(again.unchanged).toEqual(["CAREER_SITE"]);
    expect(POSTINGS).toHaveLength(1);
    expect(transitionRows()).toHaveLength(1);
  });

  it("opens a NEW posting when a previously closed channel is re-published, keeping the old closure", async () => {
    await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });
    await unpublishPosting({ requisitionId: 5, channel: "CAREER_SITE", reason: "REPOSTED", actorId: 9, tenantId: TENANT });
    await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });

    expect(POSTINGS).toHaveLength(2);
    expect(activePostings()).toHaveLength(1);
    expect(POSTINGS[0]).toMatchObject({ isActive: false, closeReason: "REPOSTED" });
  });

  it("cannot publish another tenant's requisition", async () => {
    REQUISITIONS = [baseRequisition({ tenantId: OTHER_TENANT })];
    await expect(publishRequisition({ id: 5, tenantId: TENANT })).rejects.toThrow(/not found/i);
    expect(POSTINGS).toHaveLength(0);
  });

  it("is blocked by a hiring freeze, which is a publication blocker as well as a submission one", async () => {
    prisma.recruitmentHiringFreeze.findFirst.mockResolvedValue({
      id: 1,
      scope: "COMPANY",
      reason: "Q4 budget review",
      isActive: true,
      tenantId: TENANT,
    });
    await expect(publishRequisition({ id: 5, tenantId: TENANT })).rejects.toThrow(/hiring freeze/i);
    expect(POSTINGS).toHaveLength(0);
  });
});

describe("Phase 4 — closing ONE channel does not end the search (§2.4a)", () => {
  beforeEach(async () => {
    await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });
    await publishRequisition({
      id: 5,
      postingChannels: ["LINKEDIN"],
      externalUrl: "https://linkedin.com/jobs/1",
      actorId: 9,
      tenantId: TENANT,
    });
    prisma.jobRequisition.update.mockClear();
    prisma.requisitionTransition.create.mockClear();
  });

  it("closes just that channel and leaves the requisition POSTED", async () => {
    const closed = await unpublishPosting({
      requisitionId: 5,
      channel: "LINKEDIN",
      reason: "EXPIRED",
      actorId: 9,
      tenantId: TENANT,
    });

    expect(closed).toMatchObject({ channel: "LINKEDIN", isActive: false, closeReason: "EXPIRED", closedById: 9 });
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(activePostings().map((p) => p.channel)).toEqual(["CAREER_SITE"]);
    // The requisition did not move, and no transition row was written: the status
    // did not change, so a from==to row would read as one.
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(prisma.requisitionTransition.create).not.toHaveBeenCalled();
  });

  it("closes by postingId too, so an operator can target one row precisely", async () => {
    const target = POSTINGS.find((p) => p.channel === "CAREER_SITE");
    const closed = await unpublishPosting({ postingId: target.id, reason: "FILLED", actorId: 9, tenantId: TENANT });
    expect(closed.id).toBe(target.id);
    expect(activePostings().map((p) => p.channel)).toEqual(["LINKEDIN"]);
  });

  it("requires a coded reason, and free text when the reason is OTHER", async () => {
    await expect(
      unpublishPosting({ requisitionId: 5, channel: "LINKEDIN", reason: "BECAUSE", tenantId: TENANT }),
    ).rejects.toThrow(/reason must be one of/i);
    await expect(
      unpublishPosting({ requisitionId: 5, channel: "LINKEDIN", reason: "", tenantId: TENANT }),
    ).rejects.toThrow(/reason is required/i);
    await expect(
      unpublishPosting({ requisitionId: 5, channel: "LINKEDIN", reason: "OTHER", tenantId: TENANT }),
    ).rejects.toThrow(/OTHER requires a free-text note/i);
    expect(activePostings()).toHaveLength(2);
  });

  it("does not let one request overwrite another's closure", async () => {
    await unpublishPosting({ requisitionId: 5, channel: "LINKEDIN", reason: "EXPIRED", tenantId: TENANT });
    await expect(
      unpublishPosting({ requisitionId: 5, channel: "LINKEDIN", reason: "FILLED", tenantId: TENANT }),
    ).rejects.toThrow(/No active posting matches|already closed/i);
    expect(POSTINGS.find((p) => p.channel === "LINKEDIN").closeReason).toBe("EXPIRED");
  });

  it("cannot close another tenant's posting", async () => {
    await expect(
      unpublishPosting({ requisitionId: 5, channel: "LINKEDIN", reason: "FILLED", tenantId: OTHER_TENANT }),
    ).rejects.toThrow(/No active posting matches/i);
    expect(activePostings()).toHaveLength(2);
  });

  it("lists the postings and names the channels that are live", async () => {
    const listed = await listRequisitionPostings(5, TENANT);
    expect(listed.activeChannels.sort()).toEqual(["CAREER_SITE", "LINKEDIN"]);
    expect(listed.status).toBe("POSTED");

    const onlyOpen = await listRequisitionPostings(5, TENANT, { includeClosed: false });
    expect(onlyOpen.postings).toHaveLength(2);
    await unpublishPosting({ requisitionId: 5, channel: "LINKEDIN", reason: "FILLED", tenantId: TENANT });
    expect((await listRequisitionPostings(5, TENANT, { includeClosed: false })).postings).toHaveLength(1);
    expect((await listRequisitionPostings(5, TENANT)).postings).toHaveLength(2);
  });
});

describe("Phase 4 — withdrawing a requisition (§2.4a / FR-01.07)", () => {
  beforeEach(async () => {
    await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });
    await publishRequisition({
      id: 5,
      postingChannels: ["LINKEDIN"],
      externalUrl: "https://linkedin.com/jobs/1",
      actorId: 9,
      tenantId: TENANT,
    });
    prisma.requisitionTransition.create.mockClear();
    enqueueHrDomainEvent.mockClear();
  });

  it("closes EVERY active posting and moves the requisition to WITHDRAWN", async () => {
    const result = await withdrawRequisition({
      id: 5,
      reason: "RECRUITMENT_CANCELLED",
      note: "headcount pulled by finance",
      actorId: 9,
      tenantId: TENANT,
    });

    expect(result.requisition.status).toBe("WITHDRAWN");
    expect(result.closedPostings).toBe(2);
    expect(activePostings()).toHaveLength(0);
    for (const posting of POSTINGS) {
      expect(posting).toMatchObject({ isActive: false, closeReason: "REQUISITION_WITHDRAWN", closedById: 9 });
      expect(posting.closedAt).toBeInstanceOf(Date);
    }
    const rows = transitionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromStatus: "POSTED",
      toStatus: "WITHDRAWN",
      source: "requisition.withdraw",
      // The code is the reportable fact and the note is the explanation, so both
      // survive in the one text column the history has.
      reason: "RECRUITMENT_CANCELLED — headcount pulled by finance",
    });
  });

  it("tells consumers WHICH closure happened rather than reusing CLOSED", async () => {
    await withdrawRequisition({ id: 5, reason: "POSTED_IN_ERROR", actorId: 9, tenantId: TENANT });
    const event = enqueueHrDomainEvent.mock.calls.at(-1)[1];
    expect(event.eventName).toBe("hr.recruitment.requisition_closed.v1");
    expect(event.payload).toMatchObject({ status: "WITHDRAWN", reason: "POSTED_IN_ERROR", requisitionId: "5" });
  });

  it("requires a coded reason, and free text when the reason is OTHER", async () => {
    await expect(withdrawRequisition({ id: 5, reason: "nope", tenantId: TENANT })).rejects.toThrow(
      /reason must be one of/i,
    );
    await expect(withdrawRequisition({ id: 5, reason: "OTHER", tenantId: TENANT })).rejects.toThrow(
      /OTHER requires a free-text note/i,
    );
    // Nothing moved and nothing was taken down.
    expect(REQUISITIONS[0].status).toBe("POSTED");
    expect(activePostings()).toHaveLength(2);
  });

  it("withdraws a submitted or approved requisition, including one that was never published", async () => {
    REQUISITIONS = [baseRequisition({ status: "PENDING_APPROVAL" })];
    POSTINGS = []; // never published: withdrawal must still be legal, closing nothing
    const submitted = await withdrawRequisition({ id: 5, reason: "DUPLICATE_REQUISITION", tenantId: TENANT });
    expect(submitted.requisition.status).toBe("WITHDRAWN");
    expect(submitted.closedPostings).toBe(0);

    REQUISITIONS = [baseRequisition({ status: "APPROVED" })];
    const approved = await withdrawRequisition({ id: 5, reason: "BUDGET_WITHDRAWN", tenantId: TENANT });
    expect(approved.requisition.status).toBe("WITHDRAWN");
  });

  it("refuses to withdraw a draft (delete it) or an already-closed requisition", async () => {
    REQUISITIONS = [baseRequisition({ status: "DRAFT" })];
    await expect(withdrawRequisition({ id: 5, reason: "RECRUITMENT_CANCELLED", tenantId: TENANT })).rejects.toThrow(
      /Invalid requisition transition/i,
    );

    REQUISITIONS = [baseRequisition({ status: "CLOSED" })];
    await expect(withdrawRequisition({ id: 5, reason: "RECRUITMENT_CANCELLED", tenantId: TENANT })).rejects.toThrow(
      /Invalid requisition transition/i,
    );
  });

  it("is terminal — a withdrawn requisition cannot be approved, posted or closed", () => {
    for (const target of ["APPROVED", "POSTED", "CLOSED", "DRAFT", "WITHDRAWN"]) {
      expect(() => assertRequisitionTransition("WITHDRAWN", target, { comments: "x" })).toThrow();
    }
  });

  it("requires a reason at the state-machine level too, not only in the service", () => {
    expect(() => assertRequisitionTransition("POSTED", "WITHDRAWN")).toThrow(/requires a reason/i);
  });

  it("cannot withdraw another tenant's requisition", async () => {
    REQUISITIONS = [baseRequisition({ tenantId: OTHER_TENANT })];
    await expect(
      withdrawRequisition({ id: 5, reason: "RECRUITMENT_CANCELLED", tenantId: TENANT }),
    ).rejects.toThrow(/not found/i);
  });

  it("stays a distinct state from CLOSED, so fill reporting can tell them apart", () => {
    const withdrawal = requisitionClosedEvent({ id: 5, tenantId: TENANT }, {}, { status: "WITHDRAWN" });
    const closure = requisitionClosedEvent({ id: 5, tenantId: TENANT }, {}, { reason: "Filled" });
    expect(withdrawal.payload.status).toBe("WITHDRAWN");
    expect(closure.payload.status).toBe("CLOSED");
    // The default is unchanged, so existing consumers see exactly what they did.
    expect(requisitionClosedEvent({ id: 5, tenantId: TENANT }, {}).payload.status).toBe("CLOSED");
  });
});

describe("Phase 4 — every close path takes the requisition off its channels (§2.4a)", () => {
  it("closes postings from the management close, and demands a reason for a published one", async () => {
    await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });

    await expect(closeRequisition("5", TENANT, 9)).rejects.toThrow(/published requisition requires a reason/i);
    expect(activePostings()).toHaveLength(1);

    await closeRequisition("5", TENANT, 9, "Opening filled");
    expect(REQUISITIONS[0].status).toBe("CLOSED");
    expect(activePostings()).toHaveLength(0);
    expect(POSTINGS[0]).toMatchObject({ closeReason: "REQUISITION_CLOSED", closedById: 9 });
  });

  it("still closes a never-published requisition without a reason", async () => {
    REQUISITIONS = [baseRequisition({ status: "DRAFT" })];
    await closeRequisition("5", TENANT, 9);
    expect(REQUISITIONS[0].status).toBe("CLOSED");
  });

  it("closes postings from the generic update too", async () => {
    await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });
    await updateRequisition(5, { status: "CLOSED", comments: "Search ended" }, 9, TENANT);

    expect(REQUISITIONS[0].status).toBe("CLOSED");
    expect(activePostings()).toHaveLength(0);
    expect(transitionRows().at(-1)).toMatchObject({ toStatus: "CLOSED", reason: "Search ended" });
  });

  it("refuses the generic close of a published requisition when no reason is supplied", async () => {
    await publishRequisition({ id: 5, actorId: 9, tenantId: TENANT });
    await expect(updateRequisition(5, { status: "CLOSED" }, 9, TENANT)).rejects.toThrow(
      /published requisition requires a reason/i,
    );
    expect(activePostings()).toHaveLength(1);
  });

  it("shares one closure helper, which is a no-op when nothing is published", async () => {
    await expect(
      closeActivePostingsForRequisition(prisma, { requisitionId: 5, tenantId: TENANT, actorId: 9 }),
    ).resolves.toBe(0);
  });

  it("does not touch another tenant's postings", async () => {
    POSTINGS.push({
      id: 99,
      requisitionId: 5,
      channel: "CAREER_SITE",
      isActive: true,
      tenantId: OTHER_TENANT,
      closedAt: null,
      closeReason: null,
      closedById: null,
    });
    const count = await closeActivePostingsForRequisition(prisma, {
      requisitionId: 5,
      tenantId: TENANT,
      actorId: 9,
    });
    expect(count).toBe(0);
    expect(POSTINGS[0].isActive).toBe(true);
  });
});

describe("Phase 4 — publication vocabulary is closed", () => {
  it("keeps the reason lists free of duplicates and non-empty", () => {
    for (const list of [PUBLICATION_CHANNELS, POSTING_CLOSE_REASONS, WITHDRAWAL_REASONS]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
      expect(list.every((value) => /^[A-Z_]+$/.test(value))).toBe(true);
      expect(list).toContain("OTHER");
    }
  });

  it("keeps the withdrawal reasons different from the posting close reasons", () => {
    // They answer different questions ("why did this recruitment stop" vs "why did
    // this channel's posting stop"), so a shared vocabulary would blur both.
    expect(WITHDRAWAL_REASONS).not.toEqual(POSTING_CLOSE_REASONS);
    expect(WITHDRAWAL_REASONS).not.toContain("REQUISITION_WITHDRAWN");
  });

  it("demands a reason only where the decision says a reason is owed", () => {
    // Submitting owes no reason; withdrawing and closing a PUBLISHED requisition do.
    expect(() => assertRequisitionTransition("DRAFT", "PENDING_APPROVAL", { requisition: baseRequisition({ status: "DRAFT" }) })).not.toThrow();
    expect(() => assertRequisitionTransition("POSTED", "WITHDRAWN", { comments: "x" })).not.toThrow();
    expect(() => assertRequisitionTransition("POSTED", "CLOSED", { comments: "x" })).not.toThrow();
    // The other half: a DRAFT still closes without one, because that is housekeeping.
    expect(() => assertRequisitionTransition("DRAFT", "CLOSED")).not.toThrow();
  });
});
