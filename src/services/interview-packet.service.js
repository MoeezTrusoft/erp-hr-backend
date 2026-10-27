// src/services/interview-packet.service.js
//
// Phase 6 / decision record §4.4 — the INTERVIEW PACKET.
//
// The matrix in lib/documentAccess.js decides audience × class. This service
// owns the persistence and the viewer-context resolution:
//
//   * Only matrix-PERMITTED classes may be packeted — screening notes,
//     feedback, budget/approval and offer documents are refused at the write
//     boundary, so no caller, flag or future endpoint can smuggle them in.
//   * Re-adding the same media to the same interview refreshes the label and
//     reports alreadyListed (idempotent, mirrors the shortlist).
//   * The interviewer view is built from viewer CONTEXT, not identity alone:
//     no InterviewInterviewer row → nothing (fail closed), even for a class
//     whose matrix cell is "yes". Recruiters and hiring managers get the full
//     packet; the candidate audience never sees the packet at all.
//   * Every denial is logged (class names only, never content) — the audit
//     trail shows the ACL working, without leaking what was denied.
//   * Phase 7 (B7) — downloadPacketDocument opens one document of the packet
//     from DAM: recruiters (ORG) from the full packet, a panelist from their
//     own packet view (the same ACL as getPacketForViewer). A media id that is
//     not in the caller's view of THIS interview is never fetched.

import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { logAction } from "../utils/logs.js";
import {
    AUDIENCES,
    PACKETABLE_CLASSES,
    canAccess,
    isPacketable,
    resolvePacketView,
} from "../lib/documentAccess.js";
import { readRecruitmentDocument } from "./recruitment-document-download.service.js";

export class PacketError extends Error {
    constructor(message, status = 400, details = undefined) {
        super(message);
        this.name = "PacketError";
        this.status = status;
        this.details = details;
    }
}

const fail = (message, status, details) => new PacketError(message, status, details);

const toInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The interview for this tenant, with the application→candidate→resume graph
 * the packet view composes from. 404 (not 403) — an unknown interview must be
 * indistinguishable from another tenant's.
 */
async function requireInterview(interviewId, tenantId) {
    const id = toInt(interviewId);
    if (!id) throw fail("Interview not found", 404, "HR-RECRUITMENT-PACKET-NOT-FOUND");
    const interview = await prisma.interview.findFirst({
        where: scopedWhere(tenantId, { id }),
        select: {
            id: true,
            tenantId: true,
            applicationId: true,
            application: {
                select: {
                    id: true,
                    candidateId: true,
                    candidate: { select: { id: true, resumeMediaId: true } },
                },
            },
        },
    });
    if (!interview) throw fail("Interview not found", 404, "HR-RECRUITMENT-PACKET-NOT-FOUND");
    return interview;
}

/** Was this employee assigned to this interview (InterviewInterviewer row)? */
function assignedInterviewerIds(interview) {
    return new Set((interview?.interviewers ?? []).map((i) => i.employeeId));
}

/**
 * Add a document to an interview's packet.
 *
 * @param {object} p
 * @param {number} p.interviewId
 * @param {string} p.docClass  PORTFOLIO | GENERAL_APPLICATION_DOC | INTERVIEW_BRIEF
 * @param {number} p.mediaId   DAM asset id
 * @param {string|null} p.label
 * @param {string|null} p.tenantId
 * @param {number|null} p.actorId  adding employee (audit only)
 */
export const addPacketItem = async ({ interviewId, docClass, mediaId, label, tenantId, actorId }) => {
    const cls = String(docClass ?? "").trim();
    if (!isPacketable(cls)) {
        throw fail(
            `Document class "${cls || "(missing)"}" cannot be added to an interview packet`,
            400,
            { code: "HR-RECRUITMENT-PACKET-CLASS-NOT-PACKETABLE", packetable: PACKETABLE_CLASSES },
        );
    }
    const mid = toInt(mediaId);
    if (!mid) throw fail("mediaId must be a positive integer", 400, { code: "HR-RECRUITMENT-PACKET-MEDIA-REQUIRED" });

    return tenantTransaction(prisma, async (tx) => {
        // Existence + tenancy (404 for unknown or cross-tenant), then the same
        // existence check INSIDE the write transaction so a concurrent delete
        // cannot resurrect a dangling packet row.
        const interview = await tx.interview.findFirst({
            where: scopedWhere(tenantId, { id: toInt(interviewId) ?? 0 }),
            select: { id: true },
        });
        if (!interview) throw fail("Interview not found", 404, "HR-RECRUITMENT-PACKET-NOT-FOUND");

        const data = scopedData(tenantId, {
            interviewId: interview.id,
            mediaId: mid,
            docClass: cls,
            label: label ? String(label).slice(0, 255) : null,
            addedById: toInt(actorId),
        });

        const existing = await tx.interviewPacketItem.findUnique({
            where: { interviewId_mediaId: { interviewId: interview.id, mediaId: mid } },
        });
        if (existing) {
            const updated = await tx.interviewPacketItem.update({
                where: { id: existing.id },
                data: { docClass: data.docClass, label: data.label ?? existing.label },
            });
            return { item: updated, alreadyListed: true };
        }

        const item = await tx.interviewPacketItem.create({ data });
        await logAction({
            employeeId: actorId ?? null,
            type: "CREATE",
            module: "Interview Packet",
            result: "SUCCESS",
            notes: `Packet item (class ${cls}, media ${mid}) added to interview "${interview.id}"`,
            tenantId: tenantId ?? null,
        });
        return { item, alreadyListed: false };
    });
};

/**
 * Remove a packet item. Conditioned on the tenant; a cross-tenant or unknown
 * id is a clean 404.
 */
export const removePacketItem = async ({ interviewId, itemId, tenantId, actorId }) => {
    const iid = toInt(interviewId);
    const id = toInt(itemId);
    if (!iid || !id) throw fail("Packet item not found", 404, "HR-RECRUITMENT-PACKET-NOT-FOUND");

    const where = scopedWhere(tenantId, { id, interviewId: iid });
    const before = await prisma.interviewPacketItem.findFirst({ where, select: { id: true } });
    if (!before) throw fail("Packet item not found", 404, "HR-RECRUITMENT-PACKET-NOT-FOUND");

    await prisma.interviewPacketItem.deleteMany({ where });
    await logAction({
        employeeId: actorId ?? null,
        type: "DELETE",
        module: "Interview Packet",
        result: "SUCCESS",
        notes: `Packet item "${id}" removed from interview "${iid}"`,
        tenantId: tenantId ?? null,
    });
    return { id, deleted: true };
};

/**
 * The recruiter/hiring-manager packet (full packet, ACL-filtered by matrix —
 * which for these audiences is everything packetable).
 */
export const listPacket = async ({ interviewId, tenantId }) => {
    const interview = await requireInterview(interviewId, tenantId);
    const items = await prisma.interviewPacketItem.findMany({
        where: scopedWhere(tenantId, { interviewId: interview.id }),
        orderBy: [{ docClass: "asc" }, { id: "asc" }],
    });
    const { visible } = resolvePacketView(
        { audience: AUDIENCES.RECRUITER },
        items,
    );
    return visible;
};

/**
 * The §4.4 INTERVIEWER packet view — the "only if in the interview packet"
 * cells made real, composed from viewer context:
 *
 *   * The interviewer must hold an InterviewInterviewer row on THIS interview
 *     ("while assigned") — no row, no view, fail closed.
 *   * RESUME: the candidate's resume asset (matrix: yes, while assigned).
 *   * INTERVIEW_BRIEF: visible without a packet row (matrix: plain yes) — the
 *     row is optional packaging for it.
 *   * PORTFOLIO / GENERAL_APPLICATION_DOC: only rows that exist in the packet.
 *   * Everything else: refused by the matrix before the view is even built.
 *
 * The response carries media ids and labels — the caller fetches bytes from
 * the DAM with its own authorization; this view never proxies document
 * content, so the ACL cannot be bypassed by reading bytes here.
 */
export const getPacketForViewer = async ({ interviewId, tenantId, viewerEmployeeId }) => {
    const interview = await requireInterview(interviewId, tenantId);

    // Assignment check first — it gates the whole view for the interviewer.
    const assigned = await prisma.interviewInterviewer.findFirst({
        where: scopedWhere(tenantId, {
            interviewId: interview.id,
            employeeId: toInt(viewerEmployeeId) ?? -1,
        }),
        select: { employeeId: true },
    });

    // The candidate audience resolves by candidate identity, not employee id.
    // A candidate viewer is only ever issued for the OWNING candidate (the
    // caller must establish that), so this surface deliberately refuses the
    // candidate audience outright: the packet is an internal view.
    const items = await prisma.interviewPacketItem.findMany({
        where: scopedWhere(tenantId, { interviewId: interview.id }),
        orderBy: [{ docClass: "asc" }, { id: "asc" }],
    });

    const ctx = { audience: AUDIENCES.INTERVIEWER, isAssignedInterviewer: Boolean(assigned) };
    const { visible, deniedClasses } = resolvePacketView(ctx, items);

    const view = [];
    // "Yes, while assigned" — the resume rides on the assignment, no packet row.
    if (assigned && interview.application?.candidate?.resumeMediaId) {
        view.push({
            docClass: "RESUME",
            mediaId: interview.application.candidate.resumeMediaId,
            label: "Resume / CV",
            source: "CANDIDATE_RECORD",
        });
    }
    for (const item of visible) {
        view.push({
            id: item.id,
            docClass: item.docClass,
            mediaId: item.mediaId,
            label: item.label,
            source: "PACKET",
        });
    }

    if (deniedClasses.length && assigned) {
        await logAction({
            employeeId: toInt(viewerEmployeeId) ?? null,
            type: "ACCESS",
            module: "Interview Packet",
            result: "DENIED",
            notes: `Interviewer packet view for interview "${interview.id}" excluded classes: ${deniedClasses.join(", ")}`,
            tenantId: tenantId ?? null,
        });
    }

    return {
        interviewId: interview.id,
        viewer: { employeeId: toInt(viewerEmployeeId) ?? null, isAssignedInterviewer: Boolean(assigned) },
        items: view,
        deniedClasses,
    };
};

// ── Phase 7 (B7) — download ─────────────────────────────────────────────────

// The Phase 3a error shape: the code on `.code` as well as `.details`.
const failCode = (message, status, code) => Object.assign(fail(message, status, code), { code });
const packetNotFound = () => failCode("Packet document not found", 404, "HR-RECRUITMENT-PACKET-NOT-FOUND");

/** The recruiter's view: every packetable item plus the candidate's resume. */
async function recruiterView(interviewId, tenantId) {
    const interview = await requireInterview(interviewId, tenantId);
    const items = await listPacket({ interviewId: interview.id, tenantId });
    const view = items.map((item) => ({ id: item.id, docClass: item.docClass, mediaId: item.mediaId, label: item.label, source: "PACKET" }));
    const resumeMediaId = interview.application?.candidate?.resumeMediaId;
    if (resumeMediaId) view.unshift({ docClass: "RESUME", mediaId: resumeMediaId, label: "Resume / CV", source: "CANDIDATE_RECORD" });
    return { interviewId: interview.id, items: view };
}

/**
 * Open one document of an interview's packet. Pick it by packet itemId, or by
 * mediaId (the resume has no packet row; its mediaId comes from the packet
 * view). Recruiters (scope ORG) reach the full packet; anyone else only their
 * own panelist view, so a caller not on the panel, a class the matrix keeps
 * from interviewers and another interview's media are all the same 404.
 *
 * @param {object} p
 * @param {object} p.scope  resolveRecruitmentScope(user)
 * @returns {Promise<{ interviewId: number, item: object, fileName: string, mimeType: string, size: number, contentBase64: string }>}
 */
export const downloadPacketDocument = async ({ interviewId, itemId = null, mediaId = null, tenantId, scope, viewerEmployeeId = null }) => {
    const wantItem = toInt(itemId);
    const wantMedia = toInt(mediaId);
    if (Boolean(wantItem) === Boolean(wantMedia)) {
        throw failCode("Pass exactly one of itemId or mediaId", 400, "HR-RECRUITMENT-PACKET-DOCUMENT-INVALID");
    }

    const view = scope?.unrestricted
        ? await recruiterView(interviewId, tenantId)
        : await getPacketForViewer({ interviewId, tenantId, viewerEmployeeId: viewerEmployeeId ?? scope?.employeeId ?? null });
    if (!scope?.unrestricted && !view.viewer?.isAssignedInterviewer) throw packetNotFound();

    const item = (view.items ?? []).find((entry) =>
        wantItem ? entry.source === "PACKET" && entry.id === wantItem : Number(entry.mediaId) === wantMedia);
    if (!item) throw packetNotFound();

    const file = await readRecruitmentDocument({
        mediaId: item.mediaId,
        fallbackName: item.label || String(item.docClass ?? "document").toLowerCase(),
        log: { tenantId, interviewId: view.interviewId, itemId: item.id ?? null },
    });
    return {
        interviewId: view.interviewId,
        item: { id: item.id ?? null, docClass: item.docClass, label: item.label ?? null, source: item.source, mediaId: item.mediaId },
        ...file,
    };
};

/** Which of the packetable classes may this caller still add? (MCP schema hint) */
export const packetableClasses = () => PACKETABLE_CLASSES.slice();

// Keep the import surface honest: canAccess is re-exported for callers that
// need the raw matrix question without importing the lib themselves.
export { canAccess };
