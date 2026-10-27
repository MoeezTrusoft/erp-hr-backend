// HR-PROFILE-PHOTO-REMOVE — detaching an employee's profile / cover photo.
//
// The slot and the DAM asset are separate concerns: this service only clears the
// employee's reference and REPORTS the detached asset id, so the caller can offer
// to move that asset to the DAM trash (a dam:asset DELETE, not an HR grant).
// These tests drive the SERVICE path with a prisma mock.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();

const prismaMock = {
  employee: { findUnique: mockFindUnique, update: mockUpdate },
};

jest.unstable_mockModule("../../src/lib/prisma.js", () => ({ default: prismaMock }));

const svc = await import("../../src/services/hrContract.service.js");

const WITH_PHOTOS = {
  id: 7,
  employee_media_id: 900,
  photo_url: "https://dam.example/a/900.png",
  cover_photo_media_id: 901,
  cover_photo_url: "https://dam.example/a/901.png",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUnique.mockResolvedValue(WITH_PHOTOS);
  mockUpdate.mockResolvedValue({ id: 7 });
});

describe("removeEmployeeProfilePhoto", () => {
  it("clears the profile slot and reports the detached DAM asset", async () => {
    const result = await svc.removeEmployeeProfilePhoto(7, 42);

    expect(result).toEqual({
      removed: true,
      mediaId: 900,
      url: "https://dam.example/a/900.png",
    });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { employee_media_id: null, photo_url: null, updatedById: 42 },
    });
  });

  it("leaves the cover slot alone", async () => {
    await svc.removeEmployeeProfilePhoto(7, 42);

    const { data } = mockUpdate.mock.calls[0][0];
    expect(data).not.toHaveProperty("cover_photo_media_id");
    expect(data).not.toHaveProperty("cover_photo_url");
  });

  it("is a no-op (and reports nothing detached) when the slot is already empty", async () => {
    mockFindUnique.mockResolvedValue({ ...WITH_PHOTOS, employee_media_id: null, photo_url: null });

    const result = await svc.removeEmployeeProfilePhoto(7, 42);

    expect(result).toEqual({ removed: false, mediaId: null, url: null });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("reports the URL even when the slot holds a non-DAM URL (no mediaId)", async () => {
    mockFindUnique.mockResolvedValue({
      ...WITH_PHOTOS,
      employee_media_id: null,
      photo_url: "data:image/png;base64,AAAA",
    });

    const result = await svc.removeEmployeeProfilePhoto(7, 42);

    expect(result).toEqual({ removed: true, mediaId: null, url: "data:image/png;base64,AAAA" });
  });

  it("404s for an unknown employee instead of silently succeeding", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(svc.removeEmployeeProfilePhoto(999, 42)).rejects.toMatchObject({ status: 404 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("removeEmployeeCoverPhoto", () => {
  it("clears the cover slot and reports the detached DAM asset", async () => {
    const result = await svc.removeEmployeeCoverPhoto(7, 42);

    expect(result).toEqual({
      removed: true,
      mediaId: 901,
      url: "https://dam.example/a/901.png",
    });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { cover_photo_media_id: null, cover_photo_url: null, updatedById: 42 },
    });
  });
});
