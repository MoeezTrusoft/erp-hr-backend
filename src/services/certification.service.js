import prisma from "../config/prisma.js";
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as `tenantId` on the args / trailing
// param; folded into training reads and stamped on creates, fail-closed so
// tenant B never reads/mutates tenant A's certifications/transcripts.

// Certifications/Transcripts screen — a cert expiring within this many days
// (and not already inactive/expired) is bucketed as due for RENEWAL.
export const RENEWAL_WINDOW_DAYS = 60;

// Single-source-of-truth effective-status precedence, shared by the KPI tiles
// and the card projection so tile counts and per-row badges never disagree:
//   INACTIVE  → status is explicitly INACTIVE
//   EXPIRED   → status EXPIRED, or expiryDate is in the past
//   RENEWAL   → status RENEWAL, or expiryDate falls inside the renewal window
//   ACTIVE    → everything else
// `now` is passed in so a whole batch is bucketed against one instant.
export const effectiveCertificationStatus = (cert, now) => {
    if (cert.status === "INACTIVE") return "INACTIVE";
    const expiry = cert.expiryDate ? new Date(cert.expiryDate) : null;
    if (cert.status === "EXPIRED" || (expiry && expiry < now)) return "EXPIRED";
    const renewalCutoff = new Date(now.getTime() + RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (cert.status === "RENEWAL" || (expiry && expiry <= renewalCutoff)) return "RENEWAL";
    return "ACTIVE";
};

// Card projection for the Certifications & Transcripts list/transcript screens.
export const toCertificationCard = (cert, now) => {
    // Employee uses snake_case name columns (first_name/last_name) + a
    // denormalized employee_name; prefer the latter, fall back to the parts.
    const first = cert.employee?.first_name ?? "";
    const last = cert.employee?.last_name ?? "";
    const owner = (cert.employee?.employee_name || `${first} ${last}`.trim()) || null;
    return {
        id: cert.id,
        category: cert.category ?? null,
        title: cert.name,
        completedOn: cert.issuedAt ?? null,
        owner,
        ownerId: cert.employeeId,
        status: effectiveCertificationStatus(cert, now),
        issuedBy: cert.issuedBy ?? null,
        expiryDate: cert.expiryDate ?? null,
        credentialId: cert.credentialId ?? null,
        courseId: cert.courseId ?? null,
        certificateMediaId: cert.certificateMediaId ?? null,
    };
};

// KPI tiles for the Certifications & Transcripts screen. Every cert is bucketed
// into EXACTLY ONE bucket via effectiveCertificationStatus, so the four counts
// sum to total.
export const getCertificationKpis = async (tenantId) => {
    const now = new Date();
    const rows = await prisma.certification.findMany({
        where: scopedWhere(tenantId, {}),
        select: { id: true, status: true, expiryDate: true },
    });
    const kpis = { active: 0, renewals: 0, inactive: 0, expired: 0, total: rows.length };
    for (const row of rows) {
        switch (effectiveCertificationStatus(row, now)) {
            case "INACTIVE":
                kpis.inactive += 1;
                break;
            case "EXPIRED":
                kpis.expired += 1;
                break;
            case "RENEWAL":
                kpis.renewals += 1;
                break;
            default:
                kpis.active += 1;
        }
    }
    return kpis;
};

export const createCertification = async ({ employeeId, name, issuedBy, issuedDate, expiryDate, courseId, category, status, tenantId }) => {
    return prisma.certification.create({
        data: scopedData(tenantId, {
            employeeId: Number(employeeId),
            name,
            issuedBy,
            issuedAt: issuedDate ? new Date(issuedDate) : new Date(),
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            courseId: courseId ? Number(courseId) : null,
            ...(category !== undefined ? { category } : {}),
            ...(status !== undefined ? { status } : {}),
        }),
    });
};

export const listCertifications = async ({ employeeId, page = 1, limit = 20, tenantId }) => {
    const where = scopedWhere(tenantId, employeeId ? { employeeId: Number(employeeId) } : {});
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
        prisma.certification.findMany({
            where,
            skip,
            take: limit,
            orderBy: { issuedAt: "desc" },
            include: { employee: { select: { id: true, employee_name: true, first_name: true, last_name: true } } },
        }),
        prisma.certification.count({ where }),
    ]);
    const now = new Date();
    const items = rows.map((row) => toCertificationCard(row, now));
    return { items, total, page, limit };
};

// Learner transcript for the Certifications & Transcripts screen: completed
// training courses + the employee's certification cards.
export const getEmployeeTranscript = async ({ tenantId, employeeId }) => {
    const empId = Number(employeeId);
    const [enrollments, certs] = await Promise.all([
        prisma.trainingEnrollment.findMany({
            where: scopedWhere(tenantId, { employeeId: empId, status: "COMPLETED" }),
            include: { course: { include: { category: true } } },
            orderBy: { completionDate: "desc" },
        }),
        prisma.certification.findMany({
            where: scopedWhere(tenantId, { employeeId: empId }),
            include: { employee: { select: { id: true, employee_name: true, first_name: true, last_name: true } } },
            orderBy: { issuedAt: "desc" },
        }),
    ]);
    const now = new Date();
    const completedCourses = enrollments.map((e) => ({
        enrollmentId: e.id,
        courseId: e.courseId,
        title: e.course?.title ?? null,
        category: e.course?.category?.name ?? null,
        completedOn: e.completionDate ?? null,
        score: e.score ?? null,
        progress: e.progress ?? null,
    }));
    const certifications = certs.map((c) => toCertificationCard(c, now));
    return { employeeId: empId, completedCourses, certifications };
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
    if (data.category !== undefined) patch.category = data.category;
    if (data.status !== undefined) patch.status = data.status;
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
