// tests/unit/requisition-publication-sweeps.test.js
//
// F-04 — auto-publish on approval and posting expiry past closesAt, through the
// real service functions over a tenant-scoped in-memory store (the where clauses
// the services build are actually evaluated, so "skips a past closesAt" and
// "never touches another tenant" are real assertions, not mock artefacts).
//
// Pinned:
//   * auto-publish publishes an APPROVED requisition ONCE (second run no-op) via
//     publishRequisition, recording source requisition.autopublish and stamping
//     publishedAt; it skips frozen, past-closesAt and already-advertised ones and
//     honours HR_RECRUITMENT_DEFAULT_CHANNELS within the channel vocabulary;
//   * expiry closes only the past-due requisition's ACTIVE postings with reason
//     EXPIRED, emits ONE hr.recruitment.postings_expired.v1 and leaves the
//     requisition status alone;
//   * publishRequisition stamps publishedAt only on the first publication.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T10:00:00Z");
const PAST = new Date("2026-10-19T10:00:00Z");
const FUTURE = new Date("2026-11-20T10:00:00Z");

let REQUISITIONS = [];
let POSTINGS = [];
let FREEZES = [];
let nextPostingId = 1;

const time = (value) => (value == null ? null : new Date(value).getTime());

const matchesDate = (value, cond) => {
  if (cond === null) return value == null;
  if (cond === undefined) return true;
  const v = time(value);
  if (v === null) return false;
  if (cond.gt !== undefined && !(v > time(cond.gt))) return false;
  if (cond.lt !== undefined && !(v < time(cond.lt))) return false;
  return true;
};

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

const matchesRequisition = (row, where = {}) => {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.tenantId !== undefined && (row.tenantId ?? null) !== where.tenantId) return false;
  if (where.status !== undefined) {
    const allowed = typeof where.status === "object" ? where.status.in : [where.status];
    if (!allowed.includes(row.status)) return false;
  }
  if ("closesAt" in where && !matchesDate(row.closesAt, where.closesAt)) return false;
  if (where.OR && !where.OR.some((arm) => matchesRequisition(row, arm))) return false;
  if (where.postings) {
    const own = POSTINGS.filter((p) => p.requisitionId === row.id);
    if (where.postings.none && own.some((p) => matchesPosting(p, where.postings.none))) return false;
    if (where.postings.some && !own.some((p) => matchesPosting(p, where.postings.some))) return false;
  }
  return true;
};

const prisma = {
  jobRequisition: {
    findMany: jest.fn(async ({ where = {}, take } = {}) =>
      REQUISITIONS.filter((r) => matchesRequisition(r, where))
        .sort((a, b) => a.id - b.id)
        .slice(0, take ?? Infinity)
        .map((r) => ({ ...r })),
    ),
    findFirst: jest.fn(async ({ where = {} } = {}) => {
      const row = REQUISITIONS.find((r) => matchesRequisition(r, where));
      return row ? { ...row } : null;
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = REQUISITIONS.find((r) => r.id === where.id);
      Object.assign(row, data);
      return { ...row };
    }),
  },
  jobPosting: {
    findFirst: jest.fn(async ({ where = {} } = {}) =>
      POSTINGS.filter((p) => matchesPosting(p, where)).sort((a, b) => b.id - a.id)[0] || null,
    ),
    findMany: jest.fn(async ({ where = {} } = {}) => POSTINGS.filter((p) => matchesPosting(p, where))),
    create: jest.fn(async ({ data }) => {
      const row = { id: nextPostingId++, channelRef: null, closedAt: null, closeReason: null, closedById: null, ...data };
      POSTINGS.push(row);
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where = {}, data = {} }) => {
      const rows = POSTINGS.filter((p) => matchesPosting(p, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    }),
  },
  requisitionTransition: { create: jest.fn(async () => ({ id: 1 })) },
  recruitmentHiringFreeze: {
    findFirst: jest.fn(async ({ where = {} } = {}) =>
      FREEZES.find(
        (f) =>
          f.tenantId === where.tenantId &&
          f.isActive &&
          (where.OR ?? []).some(
            (arm) => arm.scope === f.scope && (arm.departmentId === undefined || arm.departmentId === f.departmentId),
          ),
      ) ?? null,
    ),
  },
  $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
  $executeRaw: jest.fn(async () => 1),
};

const enqueueHrDomainEvent = jest.fn(async (_tx, args) => (args ? { id: "evt" } : null));

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: jest.fn((client, fn) => fn(client)),
  rlsTenantExtension: jest.fn((client) => client),
}));

const { autoPublishApprovedRequisitions, closePostingsPastClosesAt, publishRequisition } = await import(
  "../../src/services/requisition-publication.service.js"
);
const { resolveDefaultPublicationChannels, DEFAULT_PUBLICATION_CHANNELS } = await import(
  "../../src/lib/requisition-publication.util.js"
);

const requisition = (overrides = {}) => ({
  id: 1,
  tenantId: TENANT,
  title: "Backend Engineer",
  departmentId: 3,
  requestedById: 7,
  status: "APPROVED",
  closesAt: null,
  publishedAt: null,
  ...overrides,
});

const posting = (overrides = {}) => ({
  id: nextPostingId++,
  requisitionId: 1,
  tenantId: TENANT,
  channel: "CAREER_SITE",
  isActive: true,
  postedAt: PAST,
  closedAt: null,
  closeReason: null,
  ...overrides,
});

const transitions = () => prisma.requisitionTransition.create.mock.calls.map(([arg]) => arg.data);
const eventsNamed = (name) =>
  enqueueHrDomainEvent.mock.calls.map(([, args]) => args).filter((args) => args?.eventName === name);

beforeEach(() => {
  jest.clearAllMocks();
  REQUISITIONS = [];
  POSTINGS = [];
  FREEZES = [];
  nextPostingId = 100;
  delete process.env.HR_RECRUITMENT_DEFAULT_CHANNELS;
});
afterEach(() => {
  delete process.env.HR_RECRUITMENT_DEFAULT_CHANNELS;
});

describe("F-04 — the auto-publish channel list", () => {
  it("defaults to the career site and keeps only channels an unattended publish can record", () => {
    expect(resolveDefaultPublicationChannels(undefined)).toEqual({ channels: ["CAREER_SITE"], rejected: [], fallback: true });
    expect(DEFAULT_PUBLICATION_CHANNELS).toEqual(["CAREER_SITE"]);
    // Case-insensitive, de-duplicated; unknown and URL-requiring channels rejected.
    expect(resolveDefaultPublicationChannels(" career_site, CAREER_SITE ,LINKEDIN,FACEBOOK")).toEqual({
      channels: ["CAREER_SITE"],
      rejected: ["LINKEDIN", "FACEBOOK"],
      fallback: false,
    });
    // A wholly-rejected list falls back rather than stopping publication.
    expect(resolveDefaultPublicationChannels("indeed,typo")).toEqual({
      channels: ["CAREER_SITE"],
      rejected: ["INDEED", "TYPO"],
      fallback: true,
    });
  });
});

describe("F-04 — autoPublishApprovedRequisitions", () => {
  it("publishes an approved requisition once through publishRequisition, then is a no-op", async () => {
    REQUISITIONS = [requisition()];

    const first = await autoPublishApprovedRequisitions({ tenantId: TENANT, now: NOW });

    expect(first.published).toEqual([{ id: 1, channels: ["CAREER_SITE"] }]);
    expect(REQUISITIONS[0].status).toBe("POSTED");
    expect(REQUISITIONS[0].publishedAt).toBeInstanceOf(Date);
    expect(POSTINGS).toHaveLength(1);
    expect(POSTINGS[0]).toMatchObject({ channel: "CAREER_SITE", isActive: true, postedById: null, tenantId: TENANT });
    expect(transitions()).toEqual([
      expect.objectContaining({ fromStatus: "APPROVED", toStatus: "POSTED", source: "requisition.autopublish", actorId: null }),
    ]);
    expect(eventsNamed("hr.recruitment.requisition_posted.v1")).toHaveLength(1);

    const second = await autoPublishApprovedRequisitions({ tenantId: TENANT, now: NOW });
    expect(second).toMatchObject({ published: [], skipped: [], failed: [] });
    expect(POSTINGS).toHaveLength(1);
    expect(transitions()).toHaveLength(1);
  });

  it("skips a requisition under a hiring freeze and leaves it APPROVED for the next run", async () => {
    REQUISITIONS = [requisition()];
    FREEZES = [{ id: 9, tenantId: TENANT, isActive: true, scope: "COMPANY", reason: "Q4 freeze" }];

    const result = await autoPublishApprovedRequisitions({ tenantId: TENANT, now: NOW });

    expect(result).toMatchObject({ published: [], skipped: [{ id: 1, reason: "HIRING_FREEZE" }], failed: [] });
    expect(REQUISITIONS[0].status).toBe("APPROVED");
    expect(POSTINGS).toHaveLength(0);

    FREEZES = [];
    expect((await autoPublishApprovedRequisitions({ tenantId: TENANT, now: NOW })).published).toHaveLength(1);
  });

  it("never publishes a requisition whose closesAt has passed; publishes open-window and no-window ones", async () => {
    REQUISITIONS = [
      requisition({ id: 1, closesAt: PAST }),
      requisition({ id: 2, closesAt: FUTURE }),
      requisition({ id: 3, closesAt: null }),
    ];

    const result = await autoPublishApprovedRequisitions({ tenantId: TENANT, now: NOW });

    expect(result.published.map((r) => r.id)).toEqual([2, 3]);
    expect(REQUISITIONS.find((r) => r.id === 1).status).toBe("APPROVED");
    expect(POSTINGS.some((p) => p.requisitionId === 1)).toBe(false);
  });

  it("skips already-advertised requisitions: POSTED ones and an APPROVED one with an active posting", async () => {
    REQUISITIONS = [
      requisition({ id: 1, status: "POSTED", publishedAt: PAST }),
      requisition({ id: 2 }),
      requisition({ id: 3, status: "PENDING_APPROVAL" }),
    ];
    POSTINGS = [posting({ requisitionId: 1 }), posting({ requisitionId: 2, channel: "REFERRAL" })];

    const result = await autoPublishApprovedRequisitions({ tenantId: TENANT, now: NOW });

    expect(result).toMatchObject({ published: [], skipped: [], failed: [] });
    expect(prisma.jobPosting.create).not.toHaveBeenCalled();
    expect(transitions()).toHaveLength(0);
  });

  it("publishes to the configured HR_RECRUITMENT_DEFAULT_CHANNELS, dropping channels it cannot record", async () => {
    REQUISITIONS = [requisition()];
    process.env.HR_RECRUITMENT_DEFAULT_CHANNELS = "career_site,LINKEDIN";

    const result = await autoPublishApprovedRequisitions({ tenantId: TENANT, now: NOW });

    expect(result.channels).toEqual(["CAREER_SITE"]);
    expect(result.published).toEqual([{ id: 1, channels: ["CAREER_SITE"] }]);
    expect(POSTINGS.map((p) => p.channel)).toEqual(["CAREER_SITE"]);
  });

  it("never touches another tenant's approved requisition", async () => {
    REQUISITIONS = [requisition({ id: 1 }), requisition({ id: 2, tenantId: OTHER })];

    const result = await autoPublishApprovedRequisitions({ tenantId: TENANT, now: NOW });

    expect(result.published.map((r) => r.id)).toEqual([1]);
    expect(REQUISITIONS.find((r) => r.id === 2).status).toBe("APPROVED");
    expect(POSTINGS.every((p) => p.tenantId === TENANT)).toBe(true);
  });
});

describe("F-04 — publishRequisition stamps publishedAt once", () => {
  it("keeps an existing publishedAt and does not stamp it for an additional channel", async () => {
    REQUISITIONS = [requisition({ status: "POSTED", publishedAt: PAST })];
    POSTINGS = [posting()];

    await publishRequisition({
      id: 1,
      tenantId: TENANT,
      postingChannels: [{ channel: "LINKEDIN", externalUrl: "https://linkedin.test/jobs/1" }],
      actorId: 9,
    });

    expect(REQUISITIONS[0].publishedAt).toBe(PAST);
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
  });

  it("records a manual publication as requisition.post (an unknown source cannot be injected)", async () => {
    REQUISITIONS = [requisition()];
    await publishRequisition({ id: 1, tenantId: TENANT, actorId: 9, source: "spoofed" });
    expect(transitions()[0]).toMatchObject({ source: "requisition.post", actorId: 9 });
    expect(REQUISITIONS[0].publishedAt).toBeInstanceOf(Date);
  });
});

describe("F-04 — closePostingsPastClosesAt", () => {
  beforeEach(() => {
    REQUISITIONS = [
      requisition({ id: 1, status: "POSTED", closesAt: PAST, publishedAt: PAST }),
      requisition({ id: 2, status: "POSTED", closesAt: FUTURE, publishedAt: PAST }),
      requisition({ id: 3, status: "POSTED", closesAt: null, publishedAt: PAST }),
      requisition({ id: 4, status: "POSTED", closesAt: PAST, tenantId: OTHER }),
    ];
    POSTINGS = [
      posting({ id: 1, requisitionId: 1, channel: "LINKEDIN", externalUrl: "https://linkedin.test/j/1" }),
      posting({ id: 2, requisitionId: 1, channel: "CAREER_SITE" }),
      posting({ id: 3, requisitionId: 1, channel: "INDEED", isActive: false, closedAt: PAST, closeReason: "OTHER" }),
      posting({ id: 4, requisitionId: 2 }),
      posting({ id: 5, requisitionId: 3 }),
      posting({ id: 6, requisitionId: 4, tenantId: OTHER }),
    ];
  });

  it("closes only the past-due requisition's active postings with EXPIRED and leaves its status", async () => {
    const result = await closePostingsPastClosesAt({ tenantId: TENANT, now: NOW });

    expect(result).toEqual([{ id: 1, channels: ["CAREER_SITE", "LINKEDIN"], closedPostings: 2 }]);
    const byId = Object.fromEntries(POSTINGS.map((p) => [p.id, p]));
    expect(byId[1]).toMatchObject({ isActive: false, closeReason: "EXPIRED", closedById: null });
    expect(byId[2]).toMatchObject({ isActive: false, closeReason: "EXPIRED" });
    expect(byId[3]).toMatchObject({ closeReason: "OTHER" }); // an earlier closure is not rewritten
    expect(byId[4].isActive).toBe(true);
    expect(byId[5].isActive).toBe(true);
    expect(byId[6].isActive).toBe(true); // other tenant
    expect(REQUISITIONS.map((r) => r.status)).toEqual(["POSTED", "POSTED", "POSTED", "POSTED"]);
    expect(prisma.jobRequisition.update).not.toHaveBeenCalled();
    expect(transitions()).toHaveLength(0);
  });

  it("emits ONE postings_expired event (ids only) and nothing on the second run", async () => {
    await closePostingsPastClosesAt({ tenantId: TENANT, now: NOW });
    const events = eventsNamed("hr.recruitment.postings_expired.v1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT,
      aggregateType: "JobRequisition",
      aggregateId: 1,
      payload: { requisitionId: "1", channels: ["CAREER_SITE", "LINKEDIN"], closesAt: PAST.toISOString(), requestedById: "7" },
    });

    enqueueHrDomainEvent.mockClear();
    expect(await closePostingsPastClosesAt({ tenantId: TENANT, now: NOW })).toEqual([]);
    expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
  });

  it("lets a recruiter who extended closesAt since the scan win", async () => {
    prisma.jobRequisition.findMany.mockImplementationOnce(async () => [{ id: 1, tenantId: TENANT }]);
    REQUISITIONS[0].closesAt = FUTURE;
    expect(await closePostingsPastClosesAt({ tenantId: TENANT, now: NOW })).toEqual([]);
    expect(POSTINGS.find((p) => p.id === 1).isActive).toBe(true);
  });
});
