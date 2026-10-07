import { jest, describe, it, expect, beforeEach } from "@jest/globals";
const db = {
  attendanceAnomaly: { findFirst: jest.fn(), updateMany: jest.fn() },
  payrollRun: { findFirst: jest.fn() },
  attendanceAnomalyApproval: { findMany: jest.fn(), deleteMany: jest.fn() },
};
const resolve = jest.fn(),
  upload = jest.fn(),
  getAsset = jest.fn();
jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
  tenantTransaction: async (_, fn) => fn(db),
}));
jest.unstable_mockModule(
  "../../src/services/attendanceAnomalyRouting.service.js",
  () => ({ resolveApprovalChain: resolve }),
);
jest.unstable_mockModule("../../src/services/dam.media.service.js", () => ({
  uploadFileToDAM: upload,
  getDamAssetById: getAsset,
}));
const {
  markAnomalyDeduction,
  returnAnomalyRequest,
  resubmitAnomalyRequest,
  uploadAnomalyAttachments,
  anomalyAttachmentUrl,
} = await import("../../src/services/anomalyManagement.service.js");
let row;
const ctx = {
  tenantId: "tenant-a",
  anomalyId: 1,
  actorEmployeeId: 30,
  actorUserId: "manager",
  version: 0,
};
beforeEach(() => {
  jest.clearAllMocks();
  row = {
    id: 1,
    employeeId: 7,
    tenantId: "tenant-a",
    date: new Date("2026-10-05"),
    status: "PENDING",
    currentApprovalLevel: 3,
    workflowVersion: 0,
    workflowHistory: [],
    attachments: [],
    sourceKind: "REGULARIZATION",
  };
  db.attendanceAnomaly.findFirst.mockImplementation(async ({ where }) =>
    where.tenantId === row.tenantId ? row : null,
  );
  db.attendanceAnomaly.updateMany.mockResolvedValue({ count: 1 });
  db.payrollRun.findFirst.mockResolvedValue(null);
  db.attendanceAnomalyApproval.findMany.mockResolvedValue([
    { id: 4, level: 2, decision: "APPROVED", comments: "Verified" },
  ]);
  resolve.mockResolvedValue([
    { level: 1, role: "Manager", approverId: 10, resolved: true },
    { level: 2, role: "HR", approverId: 20, resolved: true },
    { level: 3, role: "Management", approverId: 30, resolved: true },
  ]);
  upload.mockResolvedValue([{ id: 101 }]);
});
describe("anomaly management authorization and history", () => {
  it("records the management mark, reason and actor with optimistic concurrency", async () => {
    await markAnomalyDeduction({
      ...ctx,
      days: 0.5,
      comment: "Repeated tardiness",
    });
    expect(db.attendanceAnomaly.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-a",
          workflowVersion: 0,
        }),
        data: expect.objectContaining({
          manualDeductionDays: 0.5,
          workflowHistory: [
            expect.objectContaining({
              actorEmployeeId: 30,
              comment: "Repeated tardiness",
            }),
          ],
        }),
      }),
    );
  });
  it.each([7, 10, 20, 99])(
    "rejects non-management employee %s",
    async (actorEmployeeId) => {
      await expect(
        markAnomalyDeduction({
          ...ctx,
          actorEmployeeId,
          days: 1,
          comment: "Reason",
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(db.attendanceAnomaly.updateMany).not.toHaveBeenCalled();
    },
  );
  it("requires a reason and an allowed fraction", async () => {
    await expect(
      markAnomalyDeduction({ ...ctx, days: 0.25, comment: "Reason" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      markAnomalyDeduction({ ...ctx, days: 1, comment: " " }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("rejects foreign tenants", async () => {
    await expect(
      markAnomalyDeduction({
        ...ctx,
        tenantId: "tenant-b",
        days: 1,
        comment: "Reason",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("rejects changes after payroll submission", async () => {
    db.payrollRun.findFirst.mockResolvedValue({ id: 42 });
    await expect(
      markAnomalyDeduction({ ...ctx, days: 1, comment: "Reason" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.attendanceAnomaly.updateMany).not.toHaveBeenCalled();
  });
  it("rejects stale and racing edits", async () => {
    await expect(
      markAnomalyDeduction({ ...ctx, version: 1, days: 1, comment: "Reason" }),
    ).rejects.toMatchObject({ status: 409 });
    db.attendanceAnomaly.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      markAnomalyDeduction({ ...ctx, days: 1, comment: "Reason" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("returns to HR and preserves earlier decisions before resetting downstream approvals", async () => {
    await returnAnomalyRequest({
      ...ctx,
      targetLevel: 2,
      comment: "Review evidence",
    });
    expect(db.attendanceAnomaly.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentApprovalLevel: 2,
          workflowHistory: [
            expect.objectContaining({
              action: "RETURN",
              targetRole: "HR",
              approvals: [expect.objectContaining({ comments: "Verified" })],
            }),
          ],
        }),
      }),
    );
    expect(db.attendanceAnomalyApproval.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a", anomalyId: 1, level: { gte: 2 } },
    });
  });
  it("lets a matrix participant return to the applicant but not forward", async () => {
    await returnAnomalyRequest({
      ...ctx,
      actorEmployeeId: 20,
      targetLevel: 0,
      comment: "Need evidence",
    });
    await expect(
      returnAnomalyRequest({
        ...ctx,
        actorEmployeeId: 20,
        targetLevel: 3,
        comment: "Forward",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("rejects nonparticipants and blank return comments", async () => {
    await expect(
      returnAnomalyRequest({
        ...ctx,
        actorEmployeeId: 99,
        targetLevel: 0,
        comment: "No",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      returnAnomalyRequest({ ...ctx, targetLevel: 0, comment: " " }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("allows only the returned applicant to resubmit and restarts at manager", async () => {
    row.currentApprovalLevel = 0;
    await expect(
      resubmitAnomalyRequest({ ...ctx, reason: "Updated" }),
    ).rejects.toMatchObject({ status: 403 });
    await resubmitAnomalyRequest({
      ...ctx,
      actorEmployeeId: 7,
      reason: "Updated",
    });
    expect(db.attendanceAnomaly.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentApprovalLevel: 1,
          reason: "Updated",
        }),
      }),
    );
  });
  it("validates attachment bytes before uploading", async () => {
    await expect(
      uploadAnomalyAttachments([
        {
          fileName: "x.pdf",
          mimeType: "application/pdf",
          fileBase64: Buffer.from("<script>").toString("base64"),
        },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(upload).not.toHaveBeenCalled();
  });
  it("stores DAM references rather than uploaded bytes or client URLs", async () => {
    expect(
      await uploadAnomalyAttachments([
        {
          fileName: "evidence.pdf",
          mimeType: "application/pdf",
          fileBase64: Buffer.from("%PDF-1.7 sample").toString("base64"),
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        mediaId: 101,
        fileName: "evidence.pdf",
        mimeType: "application/pdf",
      }),
    ]);
  });
  it("requires request membership to download attachments", async () => {
    row.attachments = [{ mediaId: 101 }];
    await expect(
      anomalyAttachmentUrl({ ...ctx, actorEmployeeId: 99, mediaId: 101 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(getAsset).not.toHaveBeenCalled();
  });
});

it("does not return evaluator evidence as if it were a submitted request", async () => {
  row.sourceKind = "evaluator";
  await expect(
    returnAnomalyRequest({ ...ctx, targetLevel: 0, comment: "Please clarify" }),
  ).rejects.toMatchObject({ status: 400 });
});
it("retains earlier attachments on applicant resubmission", async () => {
  row.currentApprovalLevel = 0;
  row.attachments = [{ mediaId: 88, fileName: "old.pdf", size: 100 }];
  await resubmitAnomalyRequest({
    ...ctx,
    actorEmployeeId: 7,
    reason: "Updated explanation",
  });
  expect(db.attendanceAnomaly.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ attachments: row.attachments }),
    }),
  );
});
