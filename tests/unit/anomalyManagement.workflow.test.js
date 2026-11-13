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
  it.each([markAnomalyDeduction,returnAnomalyRequest,resubmitAnomalyRequest])('retires legacy arbitrary marks and day-level workflow mutations',async fn=>{
    await expect(fn({...ctx,days:0.5,comment:'Legacy request',reason:'Old flow'})).rejects.toMatchObject({status:410});
    expect(db.attendanceAnomaly.updateMany).not.toHaveBeenCalled();
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
