// FEAT base64 media (FE inline upload): the FE sends an employee's documents /
// profile / cover photo as base64 (or a data: URI) inside the JSON-RPC payload,
// and the BE decodes → uploads to DAM → extracts fileName/mimeType/fileSize
// itself. No pre-uploaded mediaId required. These tests drive the SERVICE path.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockEmployeeCreate = jest.fn();
const mockEmployeeFindUnique = jest.fn();
const mockEmergencyCreateMany = jest.fn();
const mockMediaCreateMany = jest.fn();
const mockTransaction = jest.fn();
const mockLogAction = jest.fn();

const prismaMock = {
  employee: { create: mockEmployeeCreate, findUnique: mockEmployeeFindUnique },
  position: { findUnique: jest.fn() },
  region: { findUnique: jest.fn() },
  emergencyContacts: { createMany: mockEmergencyCreateMany },
  employeeMedia: { createMany: mockMediaCreateMany },
  $transaction: mockTransaction,
};

const mockUploadFileToDAM = jest.fn();
const mockNormalizeDamAssetResponse = jest.fn();
const mockGetDamAssetById = jest.fn();

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prismaMock }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction: mockLogAction }));
jest.unstable_mockModule("../../src/services/dam.media.service.js", () => ({
  uploadFileToDAM: mockUploadFileToDAM,
  normalizeDamAssetResponse: mockNormalizeDamAssetResponse,
  getDamAssetById: mockGetDamAssetById,
}));

const svc = await import("../../src/services/hrContract.service.js");

const CREATED = { id: 101, first_name: "Ada", last_name: "Lovelace" };
const B64 = Buffer.from("hello-pdf-bytes").toString("base64");

beforeEach(() => {
  jest.clearAllMocks();
  mockTransaction.mockImplementation(async (fn) => {
    const tx = {
      employee: { create: mockEmployeeCreate.mockResolvedValue(CREATED) },
      emergencyContacts: { createMany: mockEmergencyCreateMany },
      employeeMedia: { createMany: mockMediaCreateMany },
    };
    mockEmployeeFindUnique.mockResolvedValue({ ...CREATED, employeeMedia: [] });
    tx.employee.findUnique = mockEmployeeFindUnique;
    return fn(tx);
  });
  mockUploadFileToDAM.mockResolvedValue({ raw: true });
  mockNormalizeDamAssetResponse.mockReturnValue({
    id: 900,
    mime_type: "application/pdf",
    file_size: 15,
    file_name: "offer.pdf",
  });
});

describe("fileFromBase64", () => {
  it("decodes a raw base64 string into a multer-style file", () => {
    const f = svc.fileFromBase64({ fileBase64: B64, fileName: "x.pdf", mimeType: "application/pdf" });
    expect(f.buffer.toString()).toBe("hello-pdf-bytes");
    expect(f).toMatchObject({ originalname: "x.pdf", mimetype: "application/pdf", size: 15 });
  });

  it("extracts the mime type from a data: URI", () => {
    const f = svc.fileFromBase64({ fileBase64: `data:image/png;base64,${Buffer.from("png").toString("base64")}` });
    expect(f.mimetype).toBe("image/png");
    expect(f.buffer.toString()).toBe("png");
  });

  it("returns null when there is no base64 content", () => {
    expect(svc.fileFromBase64(null)).toBeNull();
    expect(svc.fileFromBase64({})).toBeNull();
    expect(svc.fileFromBase64({ fileBase64: "" })).toBeNull();
  });
});

describe("createEmployee — inline base64 documents & photos", () => {
  it("uploads a base64 document to DAM and stores the derived media (no mediaId needed)", async () => {
    await svc.createEmployee(
      {
        firstName: "Ada",
        lastName: "Lovelace",
        documents: [{ title: "Offer", category: "CONTRACT", fileBase64: B64, fileName: "offer.pdf" }],
      },
      1,
      { tenantId: "t-1" }
    );

    expect(mockUploadFileToDAM).toHaveBeenCalledTimes(1);
    const [fileArg, typeArg] = mockUploadFileToDAM.mock.calls[0];
    expect(fileArg.buffer.toString()).toBe("hello-pdf-bytes");
    expect(typeArg).toBe("employee-document");

    expect(mockMediaCreateMany).toHaveBeenCalledTimes(1);
    const row = mockMediaCreateMany.mock.calls[0][0].data[0];
    expect(row.media_id).toBe(900);
    expect(row.mime_type).toBe("application/pdf");
    expect(row.file_size).toBe(15);
  });

  it("uploads a base64 profile photo to DAM", async () => {
    await svc.createEmployee(
      { firstName: "Ada", lastName: "Lovelace", profilePhotoBase64: B64, profilePhotoFileName: "me.png" },
      1,
      { tenantId: "t-1" }
    );
    const types = mockUploadFileToDAM.mock.calls.map((c) => c[1]);
    expect(types).toContain("employee-profile-photo");
  });
});
