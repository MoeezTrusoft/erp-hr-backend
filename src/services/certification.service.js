import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";

export const createCertification = async ({ employeeId, title, issuedBy, issuedAt, expiryDate, courseId }) => {
    return prisma.certification.create({
        data: {
            employeeId: Number(employeeId),
            title,
            issuedBy,
            issuedAt: issuedAt ? new Date(issuedAt) : new Date(),
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            courseId: courseId ? Number(courseId) : null,
        },
    });
};

export const listCertifications = async ({ employeeId, page = 1, limit = 20 }) => {
    const where = employeeId ? { employeeId: Number(employeeId) } : {};
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.certification.findMany({ where, skip, take: limit, orderBy: { issuedAt: "desc" } }),
        prisma.certification.count({ where }),
    ]);
    return { items, total, page, limit };
};

export const updateCertification = async (id, data) => {
    return prisma.certification.update({ where: { id: Number(id) }, data });
};

export const deleteCertification = async (id) => {
    return prisma.certification.delete({ where: { id: Number(id) } });
};

export const uploadCertificateFile = async (id, file) => {
    const uploaded = await uploadFileToDAM(file, "document");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    return prisma.certification.update({
        where: { id: Number(id) },
        data: { certificateMediaId: uploaded[0].id },
    });
};

export const getTranscript = async (employeeId) => {
    const [enrollments, certifications, attendedSessions] = await Promise.all([
        prisma.learningPathEnrollment.findMany({
            where: { employeeId: Number(employeeId) },
            include: { path: { include: { courses: { include: { course: true } } } } },
        }),
        prisma.certification.findMany({ where: { employeeId: Number(employeeId) } }),
        prisma.trainingSessionAttendee.findMany({
            where: { employeeId: Number(employeeId), attended: true },
            include: { session: { include: { course: true } } },
        }),
    ]);
    return { enrollments, certifications, attendedSessions };
};
