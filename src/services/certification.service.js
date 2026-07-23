import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into training reads and stamped on creates, fail-closed so
// tenant B never reads/mutates tenant A's certifications/transcripts.

export const createCertification = async ({ employeeId, name, issuedBy, issuedDate, expiryDate, courseId, tenantId }) => {
    return prisma.certification.create({
        data: scopedData(tenantId, {
            employeeId: Number(employeeId),
            name,
            issuedBy,
            issuedAt: issuedDate ? new Date(issuedDate) : new Date(),
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            courseId: courseId ? Number(courseId) : null,
        }),
    });
};

export const listCertifications = async ({ employeeId, page = 1, limit = 20, tenantId }) => {
    const where = scopedWhere(tenantId, employeeId ? { employeeId: Number(employeeId) } : {});
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.certification.findMany({ where, skip, take: limit, orderBy: { issuedAt: "desc" } }),
        prisma.certification.count({ where }),
    ]);
    return { items, total, page, limit };
};

export const getCertification = async (id, tenantId) => {
    const existing = await prisma.certification.findFirst({
        where: scopedWhere(tenantId, { id: Number(id) }),
        include: {
            employee: { select: { id: true, employee_name: true, first_name: true, last_name: true } },
            course: { select: { id: true, title: true } },
        },
    });
    if (!existing) throw new Error("Certification not found");
    return existing;
};

export const updateCertification = async (id, data, tenantId) => {
    const existing = await prisma.certification.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Certification not found");
    // normalize incoming fields to Prisma column types/shapes
    const patch = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.issuedBy !== undefined) patch.issuedBy = data.issuedBy;
    if (data.issuedDate !== undefined) patch.issuedAt = data.issuedDate ? new Date(data.issuedDate) : null;
    if (data.expiryDate !== undefined) patch.expiryDate = data.expiryDate ? new Date(data.expiryDate) : null;
    if (data.credentialId !== undefined) patch.credentialId = data.credentialId;
    if (data.courseId !== undefined) patch.courseId = data.courseId ? Number(data.courseId) : null;
    return prisma.certification.update({ where: { id: Number(id) }, data: patch });
};

export const deleteCertification = async (id, tenantId) => {
    const existing = await prisma.certification.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Certification not found");
    return prisma.certification.delete({ where: { id: Number(id) } });
};

export const uploadCertificateFile = async (id, file, tenantId) => {
    const existing = await prisma.certification.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Certification not found");
    const uploaded = await uploadFileToDAM(file, "document");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    return prisma.certification.update({
        where: { id: Number(id) },
        data: { certificateMediaId: uploaded[0].id },
    });
};

export const getTranscript = async (employeeId, tenantId) => {
    const [enrollments, certifications, attendedSessions] = await Promise.all([
        prisma.learningPathEnrollment.findMany({
            where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
            include: { path: { include: { courses: { include: { course: true } } } } },
        }),
        prisma.certification.findMany({ where: scopedWhere(tenantId, { employeeId: Number(employeeId) }) }),
        prisma.trainingSessionAttendee.findMany({
            where: scopedWhere(tenantId, { employeeId: Number(employeeId), attended: true }),
            include: { session: { include: { course: true } } },
        }),
    ]);
    return { enrollments, certifications, attendedSessions };
};
