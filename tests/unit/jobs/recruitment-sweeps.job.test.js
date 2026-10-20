// tests/unit/jobs/recruitment-sweeps.job.test.js
//
// D-07 — requisition auto-close and talent-pool invitation expiry existed as
// tenant-scoped functions with no caller. Pinned here: both are scheduled with
// stable job ids, each job sweeps every tenant that has work, one tenant's
// failure never aborts the others, and the workflow flag turns both off.
//
// F-02 / F-04 — the approval-SLA, auto-publish and posting-expiry sweeps: same
// registration + tenant-isolation contract, each behind its flag. The approval
// SLA body runs for real over an in-memory Approval Centre + outbox (the real
// enqueueHrDomainEvent validates the envelope), so thresholds and the
// outbox-keyed dedupe are asserted on the rows that would be written.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

let REQUESTS = [];
let AUDITS = [];
let OUTBOX = [];

const inList = (value, cond) => (cond === undefined ? true : cond?.in ? cond.in.includes(value) : value === cond);
const matchesRequest = (row, where = {}) =>
  inList(row.tenantId, where.tenantId) && inList(row.id, where.id) && inList(row.kind, where.kind) && inList(row.stage, where.stage);

const prisma = {
  jobRequisition: { findMany: jest.fn() },
  talentPoolInvitation: { findMany: jest.fn() },
  hrApprovalRequest: {
    findMany: jest.fn(async ({ where = {}, distinct } = {}) => {
      const rows = REQUESTS.filter((r) => matchesRequest(r, where)).map((r) => ({ ...r }));
      if (!distinct?.includes("tenantId")) return rows;
      return [...new Map(rows.map((r) => [r.tenantId, r])).values()];
    }),
    findFirst: jest.fn(async ({ where = {} } = {}) => {
      const row = REQUESTS.find((r) => matchesRequest(r, where));
      return row ? { ...row } : null;
    }),
  },
  hrApprovalAudit: {
    findMany: jest.fn(async ({ where = {} } = {}) =>
      AUDITS.filter((a) => inList(a.tenantId, where.tenantId) && inList(a.approvalRef, where.approvalRef)),
    ),
  },
  outboxEvent: {
    findFirst: jest.fn(async ({ where = {} } = {}) =>
      OUTBOX.find(
        (o) => o.tenantId === where.tenantId && o.eventName === where.eventName && o.aggregateId === where.aggregateId,
      ) ?? null,
    ),
    create: jest.fn(async ({ data }) => {
      const row = { id: `outbox-${OUTBOX.length + 1}`, ...data };
      OUTBOX.push(row);
      return row;
    }),
  },
  $transaction: jest.fn(async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
  $executeRaw: jest.fn(async () => 1),
};
const autoCloseFilledRequisitions = jest.fn();
const autoPublishApprovedRequisitions = jest.fn();
const closePostingsPastClosesAt = jest.fn();
const expireInvitations = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/services/requisitionPublication.service.js", () => ({
  autoCloseFilledRequisitions,
  autoPublishApprovedRequisitions,
  closePostingsPastClosesAt,
}));
jest.unstable_mockModule("../../../src/services/talentPoolInvitation.service.js", () => ({ expireInvitations }));

const {
  runRequisitionAutoCloseJob,
  runTalentPoolInvitationExpiryJob,
  runRequisitionPostingExpiryJob,
  runRequisitionAutoPublishJob,
  runRecruitmentApprovalSlaJob,
} = await import("../../../src/services/reminderScheduler.service.js");
const {
  repeatableJobs,
  buildReminderProcessor,
  JOB_REQUISITION_AUTOCLOSE,
  JOB_TALENT_POOL_INVITATION_EXPIRY,
  JOB_REQUISITION_POSTING_EXPIRY,
  JOB_REQUISITION_AUTOPUBLISH,
  JOB_RECRUITMENT_APPROVAL_SLA,
  JOB_RECRUITMENT_SCHEDULED_DISPOSITION,
  JOB_RECRUITMENT_SCORING,
  JOB_CANDIDATE_DUPLICATE_DETECTION,
  JOB_OFFER_EXPIRY,
  JOB_ESIGN_WEBHOOK_RETRY,
} = await import("../../../src/jobs/reminder.queue.js");
const { approvalSlaConfig, approvalSlaKey } = await import("../../../src/services/recruitment-approval-sla.service.js");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const FLAG_ENVS = [
  "HR_RECRUITMENT_WORKFLOW_ENFORCEMENT",
  "HR_RECRUITMENT_APPROVAL_SLA",
  "HR_RECRUITMENT_APPROVAL_SLA_HOURS",
  "HR_RECRUITMENT_APPROVAL_SLA_STAGE_HOURS",
  "HR_RECRUITMENT_AUTO_PUBLISH",
  "HR_RECRUITMENT_POSTING_EXPIRY",
];

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of FLAG_ENVS) delete process.env[key];
  REQUESTS = [];
  AUDITS = [];
  OUTBOX = [];
});
afterEach(() => {
  for (const key of FLAG_ENVS) delete process.env[key];
});

describe("recruitment sweeps are scheduled", () => {
  it("registers both jobs with stable ids", () => {
    const jobs = repeatableJobs();
    const byName = Object.fromEntries(jobs.map((job) => [job.name, job]));
    expect(byName[JOB_REQUISITION_AUTOCLOSE].opts.jobId).toBe("repeat:requisition-autoclose");
    expect(byName[JOB_TALENT_POOL_INVITATION_EXPIRY].opts.jobId).toBe("repeat:talent-pool-invitation-expiry");
  });
});

describe("requisition auto-close job", () => {
  it("sweeps every tenant with an opted-in, unclosed requisition", async () => {
    prisma.jobRequisition.findMany.mockResolvedValue([{ tenantId: A }, { tenantId: B }, { tenantId: null }]);
    autoCloseFilledRequisitions.mockImplementation(async ({ tenantId }) => (tenantId === A ? [{ id: 1 }] : []));

    const result = await runRequisitionAutoCloseJob();

    expect(autoCloseFilledRequisitions.mock.calls.map(([args]) => args.tenantId)).toEqual([A, B]);
    expect(result).toMatchObject({ tenants: 2, closed: 1 });
  });

  it("reports one tenant's failure without aborting the others", async () => {
    prisma.jobRequisition.findMany.mockResolvedValue([{ tenantId: A }, { tenantId: B }]);
    autoCloseFilledRequisitions
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValueOnce([{ id: 2 }]);

    const result = await runRequisitionAutoCloseJob();

    expect(result.closed).toBe(1);
    expect(result.perTenant[0]).toMatchObject({ tenantId: A, error: "lock timeout" });
  });

  it("does nothing while the workflow flag is off", async () => {
    process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT = "off";
    const result = await runRequisitionAutoCloseJob();
    expect(result.skipped).toBe("flag-disabled");
    expect(prisma.jobRequisition.findMany).not.toHaveBeenCalled();
  });
});

describe("talent-pool invitation expiry job", () => {
  it("applies expiry (not a dry run) for every tenant with overdue invitations", async () => {
    const asOf = new Date("2026-10-21T04:20:00Z");
    prisma.talentPoolInvitation.findMany.mockResolvedValue([{ tenantId: A }]);
    expireInvitations.mockResolvedValue({ dryRun: false, expired: [7, 8] });

    const result = await runTalentPoolInvitationExpiryJob({ asOf });

    expect(prisma.talentPoolInvitation.findMany.mock.calls[0][0].where).toEqual({ status: "INVITED", expiresAt: { lte: asOf } });
    expect(expireInvitations).toHaveBeenCalledWith({ tenantId: A, asOf, dryRun: false });
    expect(result).toMatchObject({ tenants: 1, expired: 2 });
  });

  it("does nothing while the workflow flag is off", async () => {
    process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT = "false";
    const result = await runTalentPoolInvitationExpiryJob();
    expect(result.skipped).toBe("flag-disabled");
    expect(expireInvitations).not.toHaveBeenCalled();
  });
});

// ── F-02 / F-04 ─────────────────────────────────────────────────────────────

describe("F-02 / F-04 sweeps are scheduled", () => {
  it("registers posting expiry, auto-publish and approval SLA with stable ids and their crons", () => {
    const byName = Object.fromEntries(repeatableJobs().map((job) => [job.name, job]));
    expect(byName[JOB_REQUISITION_POSTING_EXPIRY].opts).toMatchObject({
      jobId: "repeat:requisition-posting-expiry",
      repeat: { pattern: "25 * * * *" },
    });
    expect(byName[JOB_REQUISITION_AUTOPUBLISH].opts).toMatchObject({
      jobId: "repeat:requisition-autopublish",
      repeat: { pattern: "*/10 * * * *" },
    });
    expect(byName[JOB_RECRUITMENT_APPROVAL_SLA].opts).toMatchObject({
      jobId: "repeat:recruitment-approval-sla",
      repeat: { pattern: "*/30 * * * *" },
    });
  });

  it("the processor dispatches each new job name to its body", async () => {
    const requisitionPostingExpiry = jest.fn(async () => "expiry");
    const requisitionAutoPublish = jest.fn(async () => "publish");
    const recruitmentApprovalSla = jest.fn(async () => "sla");
    const processor = buildReminderProcessor({ requisitionPostingExpiry, requisitionAutoPublish, recruitmentApprovalSla });

    await expect(processor({ name: JOB_REQUISITION_POSTING_EXPIRY, data: {} })).resolves.toBe("expiry");
    await expect(processor({ name: JOB_REQUISITION_AUTOPUBLISH, data: {} })).resolves.toBe("publish");
    await expect(processor({ name: JOB_RECRUITMENT_APPROVAL_SLA, data: { correlationId: "c-1" } })).resolves.toBe("sla");
    expect(recruitmentApprovalSla).toHaveBeenCalledWith(expect.objectContaining({ correlationId: "c-1" }));
  });
});

describe("Phase 2 intake and screening jobs are scheduled", () => {
  it("registers the disposition, scoring and duplicate jobs with stable ids and their crons", () => {
    const byName = Object.fromEntries(repeatableJobs().map((job) => [job.name, job]));
    expect(byName[JOB_RECRUITMENT_SCHEDULED_DISPOSITION].opts).toMatchObject({
      jobId: "repeat:recruitment-scheduled-disposition",
      repeat: { pattern: "*/15 * * * *" },
    });
    expect(byName[JOB_RECRUITMENT_SCORING].opts).toMatchObject({
      jobId: "repeat:recruitment-scoring",
      repeat: { pattern: "7,22,37,52 * * * *" },
    });
    expect(byName[JOB_CANDIDATE_DUPLICATE_DETECTION]).toMatchObject({
      data: { lookbackHours: 2 },
      opts: { jobId: "repeat:candidate-duplicate-detection", repeat: { pattern: "40 * * * *" } },
    });
  });

  it("the processor dispatches each Phase 2 job name to its body", async () => {
    const scheduledDisposition = jest.fn(async () => "disposition");
    const applicationScoring = jest.fn(async () => "scoring");
    const candidateDuplicateDetection = jest.fn(async () => "duplicates");
    const processor = buildReminderProcessor({ scheduledDisposition, applicationScoring, candidateDuplicateDetection });

    await expect(processor({ name: JOB_RECRUITMENT_SCHEDULED_DISPOSITION, data: {} })).resolves.toBe("disposition");
    await expect(processor({ name: JOB_RECRUITMENT_SCORING, data: {} })).resolves.toBe("scoring");
    await expect(processor({ name: JOB_CANDIDATE_DUPLICATE_DETECTION, data: { lookbackHours: 2 } })).resolves.toBe("duplicates");
    expect(candidateDuplicateDetection).toHaveBeenCalledWith(expect.objectContaining({ lookbackHours: 2 }));
  });
});

describe("Phase 3a jobs are scheduled", () => {
  it("registers offer expiry hourly at :35 and dispatches it", async () => {
    const byName = Object.fromEntries(repeatableJobs().map((job) => [job.name, job]));
    expect(byName[JOB_OFFER_EXPIRY].opts).toMatchObject({ jobId: "repeat:offer-expiry", repeat: { pattern: "35 * * * *" } });
    const offerExpiry = jest.fn(async () => "expiry");
    const processor = buildReminderProcessor({ offerExpiry });
    await expect(processor({ name: JOB_OFFER_EXPIRY, data: {} })).resolves.toBe("expiry");
  });

  it("registers the e-signature retry every 15 minutes and dispatches it", async () => {
    const byName = Object.fromEntries(repeatableJobs().map((job) => [job.name, job]));
    expect(byName[JOB_ESIGN_WEBHOOK_RETRY].opts).toMatchObject({
      jobId: "repeat:esign-webhook-retry",
      repeat: { pattern: "4,19,34,49 * * * *" },
    });
    const esignWebhookRetry = jest.fn(async () => "retry");
    const processor = buildReminderProcessor({ esignWebhookRetry });
    await expect(processor({ name: JOB_ESIGN_WEBHOOK_RETRY, data: {} })).resolves.toBe("retry");
  });
});

describe("F-04 — requisition posting expiry job", () => {
  it("sweeps every tenant with a POSTED requisition past closesAt, isolating failures", async () => {
    process.env.HR_RECRUITMENT_POSTING_EXPIRY = "on";
    const now = new Date("2026-10-20T10:00:00Z");
    prisma.jobRequisition.findMany.mockResolvedValue([{ tenantId: A }, { tenantId: B }]);
    closePostingsPastClosesAt
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce([{ id: 4, channels: ["CAREER_SITE"], closedPostings: 1 }]);

    const result = await runRequisitionPostingExpiryJob({ now });

    expect(prisma.jobRequisition.findMany.mock.calls[0][0].where).toEqual({ status: "POSTED", closesAt: { lt: now } });
    expect(closePostingsPastClosesAt.mock.calls.map(([args]) => args)).toEqual([
      { tenantId: A, now },
      { tenantId: B, now },
    ]);
    expect(result).toMatchObject({ tenants: 2, expired: 1 });
    expect(result.perTenant[0]).toMatchObject({ tenantId: A, error: "deadlock" });
  });

  it("is a no-op by default (postingExpiry flag OFF), even with workflow enforcement on", async () => {
    const result = await runRequisitionPostingExpiryJob();
    expect(result.skipped).toBe("flag-disabled");
    expect(prisma.jobRequisition.findMany).not.toHaveBeenCalled();
    expect(closePostingsPastClosesAt).not.toHaveBeenCalled();
  });

  it("runs on its own flag, independent of the workflow flag", async () => {
    process.env.HR_RECRUITMENT_POSTING_EXPIRY = "on";
    process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT = "off";
    prisma.jobRequisition.findMany.mockResolvedValue([]);
    const result = await runRequisitionPostingExpiryJob();
    expect(result.skipped).toBeUndefined();
    expect(prisma.jobRequisition.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("F-04 — requisition auto-publish job", () => {
  it("is a no-op by default (autoPublish flag OFF)", async () => {
    const result = await runRequisitionAutoPublishJob();
    expect(result.skipped).toBe("flag-disabled");
    expect(prisma.jobRequisition.findMany).not.toHaveBeenCalled();
    expect(autoPublishApprovedRequisitions).not.toHaveBeenCalled();
  });

  it("publishes per tenant with APPROVED requisitions once the flag is on", async () => {
    process.env.HR_RECRUITMENT_AUTO_PUBLISH = "on";
    prisma.jobRequisition.findMany.mockResolvedValue([{ tenantId: A }, { tenantId: null }, { tenantId: B }]);
    autoPublishApprovedRequisitions.mockImplementation(async ({ tenantId }) => ({
      published: tenantId === A ? [{ id: 1, channels: ["CAREER_SITE"] }] : [],
      skipped: tenantId === B ? [{ id: 2, reason: "HIRING_FREEZE" }] : [],
      failed: [],
    }));

    const result = await runRequisitionAutoPublishJob();

    expect(prisma.jobRequisition.findMany.mock.calls[0][0].where).toEqual({ status: "APPROVED" });
    expect(autoPublishApprovedRequisitions.mock.calls.map(([args]) => args.tenantId)).toEqual([A, B]);
    expect(result).toMatchObject({ tenants: 2, published: 1 });
    expect(result.perTenant[1]).toMatchObject({ tenantId: B, published: 0, skipped: 1 });
  });
});

describe("F-02 — recruitment approval SLA job", () => {
  const NOW = new Date("2026-10-20T12:00:00Z");
  const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);
  const request = (overrides = {}) => ({
    id: "r-1",
    tenantId: A,
    kind: "REQUISITION",
    sourceRef: "41",
    stage: "LINE_MANAGER",
    version: 1,
    round: 1,
    employeeCode: "EMP-001",
    managerCode: "EMP-900",
    createdAt: hoursAgo(500),
    ...overrides,
  });
  const audit = (approvalRef, createdAt, tenantId = A) => ({ approvalRef, tenantId, createdAt });
  const on = () => {
    process.env.HR_RECRUITMENT_APPROVAL_SLA = "true";
  };
  const outboxKeys = () => OUTBOX.map((o) => `${o.eventName}|${o.aggregateId}`).sort();

  it("is a no-op while the approvalSla flag is off (the default)", async () => {
    REQUESTS = [request()];
    const result = await runRecruitmentApprovalSlaJob({ now: NOW });
    expect(result.skipped).toBe("flag-disabled");
    expect(prisma.hrApprovalRequest.findMany).not.toHaveBeenCalled();
    expect(OUTBOX).toHaveLength(0);
  });

  it("reminds at >= 1x SLA and escalates at >= 2x, timing from the latest audit row", async () => {
    on();
    REQUESTS = [
      request({ id: "r-under", stage: "LINE_MANAGER" }),
      request({ id: "r-remind", stage: "HR", kind: "OFFER", sourceRef: "77", version: 3, round: 2 }),
      request({ id: "r-escalate", stage: "MANAGEMENT", version: 5 }),
      // No audit row: the request's own createdAt is the clock.
      request({ id: "r-fallback", stage: "LINE_MANAGER", createdAt: hoursAgo(49) }),
    ];
    AUDITS = [
      audit("r-under", hoursAgo(300)), // older row — superseded by the latest
      audit("r-under", hoursAgo(47)),
      audit("r-remind", hoursAgo(50)),
      audit("r-escalate", hoursAgo(100)),
    ];

    const result = await runRecruitmentApprovalSlaJob({ now: NOW, correlationId: "corr-sla" });

    expect(result).toMatchObject({ tenants: 1, reminded: 3, escalated: 1 });
    expect(outboxKeys()).toEqual([
      "hr.recruitment.approval_escalated.v1|r-escalate:5:MANAGEMENT:escalation",
      "hr.recruitment.approval_reminder.v1|r-escalate:5:MANAGEMENT:reminder",
      "hr.recruitment.approval_reminder.v1|r-fallback:1:LINE_MANAGER:reminder",
      "hr.recruitment.approval_reminder.v1|r-remind:3:HR:reminder",
    ]);

    const reminder = OUTBOX.find((o) => o.aggregateId === "r-remind:3:HR:reminder");
    expect(reminder).toMatchObject({ tenantId: A, aggregateType: "HrApprovalRequest" });
    expect(reminder.payload).toMatchObject({ name: "hr.recruitment.approval_reminder.v1", tenantId: A, correlationId: "corr-sla" });
    expect(reminder.payload.payload).toEqual({
      approvalRef: "r-remind",
      kind: "OFFER",
      sourceRef: "77",
      stage: "HR",
      round: 2,
      version: 3,
      stageEnteredAt: hoursAgo(50).toISOString(),
      hoursInStage: 50,
      slaHours: 48,
      initiatorCode: "EMP-001",
      managerCode: "EMP-900",
      stageOwnerCode: null, // HR is a permission-resolved role
    });
    const escalation = OUTBOX.find((o) => o.aggregateId.endsWith(":escalation"));
    expect(escalation.payload.payload).toMatchObject({ stage: "MANAGEMENT", hoursInStage: 100, escalateToRole: "MANAGEMENT" });
    const fallback = OUTBOX.find((o) => o.aggregateId.startsWith("r-fallback"));
    expect(fallback.payload.payload).toMatchObject({ stageOwnerCode: "EMP-900", hoursInStage: 49 });
    // ids only — no names or emails travel in the payload.
    for (const row of OUTBOX) {
      expect(Object.keys(row.payload.payload).some((k) => /name|email/i.test(k))).toBe(false);
    }
  });

  it("dedupes on the outbox: a second run enqueues nothing, a new version gets a fresh clock", async () => {
    on();
    REQUESTS = [request({ id: "r-1", stage: "HR", version: 2 })];
    AUDITS = [audit("r-1", hoursAgo(60))];

    await runRecruitmentApprovalSlaJob({ now: NOW });
    expect(OUTBOX).toHaveLength(1);

    const second = await runRecruitmentApprovalSlaJob({ now: NOW });
    expect(second).toMatchObject({ reminded: 0, escalated: 0 });
    expect(second.perTenant[0]).toMatchObject({ deduped: 1 });
    expect(OUTBOX).toHaveLength(1);

    // Returned and resubmitted into the same stage: new version, new key.
    REQUESTS[0] = { ...REQUESTS[0], version: 4 };
    AUDITS.push(audit("r-1", hoursAgo(49)));
    await runRecruitmentApprovalSlaJob({ now: NOW });
    expect(outboxKeys()).toEqual([
      "hr.recruitment.approval_reminder.v1|r-1:2:HR:reminder",
      "hr.recruitment.approval_reminder.v1|r-1:4:HR:reminder",
    ]);
    expect(approvalSlaKey(REQUESTS[0], "reminder")).toBe("r-1:4:HR:reminder");
  });

  it("ignores terminal stages, the INITIATOR stage and non-recruitment kinds", async () => {
    on();
    REQUESTS = [
      request({ id: "t-approved", stage: "APPROVED" }),
      request({ id: "t-rejected", stage: "REJECTED" }),
      request({ id: "t-withdrawn", stage: "WITHDRAWN" }),
      request({ id: "t-initiator", stage: "INITIATOR" }),
      request({ id: "t-leave", kind: "LEAVE", stage: "HR" }),
    ];

    const result = await runRecruitmentApprovalSlaJob({ now: NOW });

    expect(result).toMatchObject({ tenants: 0, reminded: 0, escalated: 0 });
    expect(OUTBOX).toHaveLength(0);
  });

  it("skips a request that moved on between the scan and the enqueue", async () => {
    on();
    REQUESTS = [request({ id: "r-moved", stage: "HR", version: 2 })];
    AUDITS = [audit("r-moved", hoursAgo(60))];
    prisma.hrApprovalRequest.findFirst.mockImplementationOnce(async () => ({ stage: "MANAGEMENT", version: 3 }));

    const result = await runRecruitmentApprovalSlaJob({ now: NOW });

    expect(result.perTenant[0]).toMatchObject({ stale: 1, reminded: 0 });
    expect(OUTBOX).toHaveLength(0);
  });

  it("keeps tenants isolated: each tenant's rows carry its own tenant, and one failure spares the rest", async () => {
    on();
    REQUESTS = [
      request({ id: "a-1", tenantId: A, stage: "HR" }),
      request({ id: "b-1", tenantId: B, stage: "HR" }),
      request({ id: "b-2", tenantId: B, stage: "LINE_MANAGER" }),
    ];
    AUDITS = [audit("a-1", hoursAgo(60), A), audit("b-1", hoursAgo(60), B), audit("b-2", hoursAgo(10), B)];

    const first = await runRecruitmentApprovalSlaJob({ now: NOW });
    expect(first).toMatchObject({ tenants: 2, reminded: 2 });
    expect(OUTBOX.map((o) => [o.tenantId, o.aggregateId]).sort()).toEqual([
      [A, "a-1:1:HR:reminder"],
      [B, "b-1:1:HR:reminder"],
    ]);
    // Every per-tenant read was scoped to that tenant.
    for (const [args] of prisma.hrApprovalAudit.findMany.mock.calls) {
      expect([A, B]).toContain(args.where.tenantId);
    }

    OUTBOX = [];
    prisma.hrApprovalAudit.findMany.mockRejectedValueOnce(new Error("connection reset"));
    const second = await runRecruitmentApprovalSlaJob({ now: NOW });
    expect(second.perTenant[0]).toMatchObject({ tenantId: A, error: "connection reset" });
    expect(second.perTenant[1]).toMatchObject({ tenantId: B, reminded: 1 });
    expect(OUTBOX.map((o) => o.tenantId)).toEqual([B]);
  });

  it("reads the SLA from env: base hours plus an optional per-stage JSON override", async () => {
    expect(approvalSlaConfig({}).hoursFor("HR")).toBe(48);
    const cfg = approvalSlaConfig({
      HR_RECRUITMENT_APPROVAL_SLA_HOURS: "24",
      HR_RECRUITMENT_APPROVAL_SLA_STAGE_HOURS: '{"LINE_MANAGER":10,"HR":"bad","BOGUS":1}',
    });
    expect([cfg.hoursFor("LINE_MANAGER"), cfg.hoursFor("HR"), cfg.hoursFor("MANAGEMENT")]).toEqual([10, 24, 24]);
    expect(approvalSlaConfig({ HR_RECRUITMENT_APPROVAL_SLA_HOURS: "-3", HR_RECRUITMENT_APPROVAL_SLA_STAGE_HOURS: "{" }).baseHours).toBe(48);

    on();
    process.env.HR_RECRUITMENT_APPROVAL_SLA_STAGE_HOURS = '{"LINE_MANAGER":10}';
    REQUESTS = [request({ id: "r-lm", stage: "LINE_MANAGER" })];
    AUDITS = [audit("r-lm", hoursAgo(21))];
    const result = await runRecruitmentApprovalSlaJob({ now: NOW });
    expect(result).toMatchObject({ reminded: 1, escalated: 1 });
    expect(OUTBOX[0].payload.payload.slaHours).toBe(10);
  });
});
