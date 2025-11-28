import prisma from "../config/prisma.js";
import { logAction } from "../utils/logs.js";
import { uploadFileToDAM, damRequest } from "../services/dam.media.service.js";

// CREATE EmployeeMedia
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
                    visibility: visibility === "true",
                    effective_date,
                    expiry_date,
                    notes,
                    media_id: file.media_id,
                },
                include: {
                    employee: true, // ✅ include employee relation
                },
            });

            // Attach DAM metadata for response
            return {
                ...dbRecord,
                damMedia: file.damMedia,
            };
        })

    );

    return created;
};



// GET ALL
// GET all employee media
export const getAllEmployeeMediaService = async () => {
    const records = await prisma.employeeMedia.findMany({
        include: {
            employee: true, // ✅ include employee details
        },
    });;

    // Fetch DAM metadata for each record
    const enriched = await Promise.all(
        records.map(async (rec) => {
            let damMedia = null;
            if (rec.media_id) {
                try {
                    const response = await damRequest(`assets/download/${rec.media_id}`, "GET");
                    damMedia = response?.items?.[0] || response;
                } catch {
                    damMedia = null;
                }
            }
            return { ...rec, damMedia };
        })
    );

    return enriched;;
};
// GET BY ID
// GET employee media by ID
export const getEmployeeMediaByIdService = async (id) => {
    const rec = await prisma.employeeMedia.findUnique({
        where: { id: Number(id) },
        include: {
            employee: true, // ✅ include employee relation
        },
    });

    if (!rec) throw new Error("Record not found");

    // Fetch DAM metadata
    let damMedia = null;
    if (rec.media_id) {
        try {
            const response = await damRequest(`assets/download/${rec.media_id}`, "GET");
            damMedia = response?.items?.[0] || response;
        } catch {
            damMedia = null;
        }
    }

    return { ...rec, damMedia };

};
// UPDATE
export const updateEmployeeMediaService = async (id, data, files) => {
    const existing = await prisma.employeeMedia.findUnique({
        where: { id: Number(id) },
        include: {
            employee: true, // ✅ include employee relation
        },
    });


    if (!existing) throw new Error("Record not found");

    let updatedMediaId = existing.media_id;
    let damMedia = null;

    // If a new file is uploaded → upload to DAM
    if (files && files.length > 0) {
        const damResponse = await uploadFileToDAM(files[0]);
        updatedMediaId = damResponse.id;
        damMedia = damResponse; // attach DAM metadata
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
                    ? data.visibility === "true"
                    : existing.visibility,
            effective_date: data.effective_date ?? existing.effective_date,
            expiry_date: data.expiry_date ?? existing.expiry_date,
            notes: data.notes ?? existing.notes,

            // update DAM file ID
            media_id: updatedMediaId,
        },

    });

    // Return DB + DAM metadata (same format as create)
    return {
        ...updated,
        damMedia: damMedia ?? { id: existing.media_id },
    };

};


// DELETE
export const deleteEmployeeMediaService = async (id) => {
    const existing = await prisma.employeeMedia.findUnique({
        where: { id: Number(id) },
    });
    if (!existing) throw new Error("Record not found");

    await prisma.mediaFile.delete({ where: { id: existing.media_id } });

    return prisma.employeeMedia.delete({
        where: { id: Number(id) },
    });
};
