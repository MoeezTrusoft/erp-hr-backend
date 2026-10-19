// tests/unit/jobs/recruitment-sweeps.job.test.js
//
// D-07 — requisition auto-close and talent-pool invitation expiry existed as
// tenant-scoped functions with no caller. Pinned here: both are scheduled with
// stable job ids, each job sweeps every tenant that has work, one tenant's
// failure never aborts the others, and the workflow flag turns both off.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const prisma = {
  jobRequisition: { findMany: jest.fn() },
  talentPoolInvitation: { findMany: jest.fn() },
};
const autoCloseFilledRequisitions = jest.fn();
const expireInvitations = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/services/requisitionPublication.service.js", () => ({ autoCloseFilledRequisitions }));
jest.unstable_mockModule("../../../src/services/talentPoolInvitation.service.js", () => ({ expireInvitations }));

const { runRequisitionAutoCloseJob, runTalentPoolInvitationExpiryJob } = await import(
  "../../../src/services/reminderScheduler.service.js"
);
const { repeatableJobs, JOB_REQUISITION_AUTOCLOSE, JOB_TALENT_POOL_INVITATION_EXPIRY } = await import(
  "../../../src/jobs/reminder.queue.js"
);

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT;
});
afterEach(() => {
  delete process.env.HR_RECRUITMENT_WORKFLOW_ENFORCEMENT;
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
