import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";

export const createSession = async ({ courseId, title, format, scheduledAt, durationMinutes, facilitatorId, maxAttendees, location, notes }) => {
    return prisma.trainingSession.create({
        data: {
            courseId: Number(courseId),
            title,
            format: format || "LIVE_IN_PERSON",
            scheduledAt: new Date(scheduledAt),
            durationMinutes: durationMinutes || 60,
            facilitatorId: facilitatorId ? Number(facilitatorId) : null,
            maxAttendees: maxAttendees ? Number(maxAttendees) : null,
            location,
            notes,
        },
    });
};

export const listSessions = async ({ courseId, page = 1, limit = 20 }) => {
    const where = courseId ? { courseId: Number(courseId) } : {};
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.trainingSession.findMany({ where, skip, take: limit, orderBy: { scheduledAt: "asc" } }),
        prisma.trainingSession.count({ where }),
    ]);
    return { items, total, page, limit };
};

export const updateSession = async (id, data) => {
    return prisma.trainingSession.update({ where: { id: Number(id) }, data });
};

export const markAttendance = async ({ sessionId, employeeId, attended }) => {
    return prisma.trainingSessionAttendee.upsert({
        where: { sessionId_employeeId: { sessionId: Number(sessionId), employeeId: Number(employeeId) } },
        update: { attended: attended ?? true },
        create: { sessionId: Number(sessionId), employeeId: Number(employeeId), attended: attended ?? true },
    });
};

export const uploadRecording = async (id, file) => {
    const uploaded = await uploadFileToDAM(file, "video");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    return prisma.trainingSession.update({
        where: { id: Number(id) },
        data: { recordingMediaId: uploaded[0].id },
    });
};
