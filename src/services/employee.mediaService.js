import prisma from "../config/prisma.js";
import { uploadFileToDAM, damRequest, getDamAssetById } from "../services/dam.media.service.js";

export const createEmployeeMediaService = async (data, fetchedMediaRecords) => {
  const {
    employee_id,
    title,
    category,
    version,
    visibility,
    effective_date,
    expiry_date,
    notes,
  } = data;

  if (!employee_id) throw new Error("employee_id is required");

  const created = await Promise.all(
    fetchedMediaRecords.map(async (file) => {
      const dbRecord = await prisma.employeeMedia.create({
        data: {
          employee_id: Number(employee_id),
          title,
          category,
          version,
          visibility: visibility === true || visibility === "true" ? "all" : visibility || "all",
          effective_date,
          expiry_date,
          notes,
          media_id: file.media_id,
        },
        include: { employee: true },
      });

      return {
        ...dbRecord,
        damMedia: file.damMedia,
      };
    })
  );

  return created;
};

export const getAllEmployeeMediaService = async () => {
  const records = await prisma.employeeMedia.findMany({
    include: { employee: true },
  });

  const enriched = await Promise.all(
    records.map(async (rec) => {
      const damMedia = rec.media_id ? await getDamAssetById(rec.media_id) : null;
      return { ...rec, damMedia };
    })
  );

  return enriched;
};

export const getEmployeeMediaByIdService = async (id) => {
  const rec = await prisma.employeeMedia.findUnique({
    where: { id: Number(id) },
    include: { employee: true },
  });

  if (!rec) throw new Error("Record not found");

  const damMedia = rec.media_id ? await getDamAssetById(rec.media_id) : null;
  return { ...rec, damMedia };
};

export const updateEmployeeMediaService = async (id, data, files) => {
  const existing = await prisma.employeeMedia.findUnique({
    where: { id: Number(id) },
    include: { employee: true },
  });

  if (!existing) throw new Error("Record not found");

  let updatedMediaId = existing.media_id;
  let damMedia = null;

  if (files && files.length > 0) {
    const uploaded = await uploadFileToDAM(files[0]);
    if (!uploaded || !uploaded[0]) {
      throw new Error("Failed to upload file to DAM");
    }
    updatedMediaId = uploaded[0].id;
    damMedia = uploaded[0];
  }

  let updatedVersion = data.version;
  if (!updatedVersion) {
    const currentVersion = existing.version || "v0";
    const match = currentVersion.match(/v(\d+)/);
    const next = match ? parseInt(match[1], 10) + 1 : 1;
    updatedVersion = `v${next}`;
  }

  const updated = await prisma.employeeMedia.update({
    where: { id: Number(id) },
    data: {
      title: data.title ?? existing.title,
      category: data.category ?? existing.category,
      version: updatedVersion,
      visibility:
        data.visibility !== undefined
          ? data.visibility === true || data.visibility === "true"
            ? "all"
            : data.visibility
          : existing.visibility,
      effective_date: data.effective_date ?? existing.effective_date,
      expiry_date: data.expiry_date ?? existing.expiry_date,
      notes: data.notes ?? existing.notes,
      media_id: updatedMediaId,
    },
  });

  return {
    ...updated,
    damMedia: damMedia ?? (updatedMediaId ? await getDamAssetById(updatedMediaId) : null),
  };
};

export const deleteEmployeeMediaService = async (id) => {
  const existing = await prisma.employeeMedia.findUnique({
    where: { id: Number(id) },
  });
  if (!existing) throw new Error("Record not found");

  if (existing.media_id) {
    const deleted = await damRequest(`assets/${existing.media_id}`, "DELETE");

    // Fallback for media-service builds without DELETE endpoint
    if (!deleted) {
      await damRequest(`assets/useage/${existing.media_id}`, "PUT", {
        isDeleted: true,
        deleted: true,
        in_use: false,
      });
    }
  }

  return prisma.employeeMedia.delete({
    where: { id: Number(id) },
  });
};
