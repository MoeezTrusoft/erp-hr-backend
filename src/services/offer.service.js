import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";

export const createOffer = async ({ applicationId, candidateId, jobRequisitionId, salary, currency, startDate, expiryDate, notes, createdById }) => {
    return prisma.offer.create({
        data: {
            applicationId: applicationId ? Number(applicationId) : null,
            candidateId: Number(candidateId),
            jobRequisitionId: jobRequisitionId ? Number(jobRequisitionId) : null,
            salary: salary ? Number(salary) : null,
            currency: currency || "USD",
            startDate: startDate ? new Date(startDate) : null,
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            notes,
            createdById: createdById ? Number(createdById) : null,
        },
    });
};

export const getOffer = async (id) => {
    return prisma.offer.findUnique({
        where: { id: Number(id) },
        include: { candidate: true, jobRequisition: true },
    });
};

export const listOffers = async ({ page = 1, limit = 20 }) => {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        prisma.offer.findMany({ skip, take: limit, orderBy: { created_at: "desc" }, include: { candidate: true } }),
        prisma.offer.count(),
    ]);
    return { items, total, page, limit };
};

export const sendOffer = async (id) => {
    return prisma.offer.update({ where: { id: Number(id) }, data: { status: "SENT", sentAt: new Date() } });
};

export const respondOffer = async (id, accepted) => {
    return prisma.offer.update({
        where: { id: Number(id) },
        data: { status: accepted ? "ACCEPTED" : "DECLINED", respondedAt: new Date() },
    });
};

export const uploadOfferLetter = async (id, file) => {
    const uploaded = await uploadFileToDAM(file, "document");
    if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");
    return prisma.offer.update({
        where: { id: Number(id) },
        data: { offerLetterMediaId: uploaded[0].id },
    });
};
