import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData, requireTenant } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded in via `tenantId`; folded
// into session reads/writes fail-closed so tenant B cannot read/mutate tenant
// A's training sessions/attendance. createSession is a sensitive write, so it
// requires a verified tenant (fail-closed) rather than silently null-scoping.

export const createSession = async ({ courseId, title, format, scheduledAt, durationMinutes, facilitatorId, maxAttendees, location, notes, tenantId }) => {
    requireTenant(tenantId);
    return prisma.trainingSession.create({
        data: scopedData(tenantId, {
            courseId: Number(courseId),
            title,
            format: format || "LIVE_IN_PERSON",
            scheduledAt: new Date(scheduledAt),
            durationMinutes: durationMinutes || 60,
            facilitatorId: facilitatorId ? Number(facilitatorId) : null,
            maxAttendees: maxAttendees ? Number(maxAttendees) : null,
            location,
            notes,
        }),
    });
};

export const listSessions = async ({ courseId, page = 1, limit = 20, tenantId }) => {
    const where = scopedWhere(tenantId, courseId ? { courseId: Number(courseId) } : {});
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.trainingSession.findMany({ where, skip, take: limit, orderBy: { scheduledAt: "asc" } }),
        prisma.trainingSession.count({ where }),
    ]);
    return { items, total, page, limit };
};

export const updateSession = async (id, data, tenantId) => {
    const existing = await prisma.trainingSession.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Training session not found");
    return prisma.trainingSession.update({ where: { id: Number(id) }, data });
};

export const markAttendance = async ({ sessionId, employeeId, attended, tenantId }) => {
    // Guard the parent session by tenant so attendance can't be stamped onto
    // another tenant's session.
    const session = await prisma.trainingSession.findFirst({ where: scopedWhere(tenantId, { id: Number(sessionId) }) });
    if (!session) throw new Error("Training session not found");
    return prisma.trainingSessionAttendee.upsert({
        where: { sessionId_employeeId: { sessionId: Number(sessionId), employeeId: Number(employeeId) } },
        update: { attended: attended ?? true },
        create: scopedData(tenantId, { sessionId: Number(sessionId), employeeId: Number(employeeId), attended: attended ?? true }),
    });
};

export const uploadRecording = async (id, file, tenantId) => {
    const existing = await prisma.trainingSession.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
    if (!existing) throw new Error("Training session not found");
    const uploaded = await uploadFileToDAM(file, "video");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    return prisma.trainingSession.update({
        where: { id: Number(id) },
        data: { recordingMediaId: uploaded[0].id },
    });
};
