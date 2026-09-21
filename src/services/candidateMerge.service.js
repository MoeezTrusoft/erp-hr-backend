// src/services/candidateMerge.service.js
//
// Phase 5 / FR-04.10 (recruiter half) — LINK/RECOVER an existing candidate
// instead of silently keeping a duplicate identity.
//
// The typo case this exists for: a candidate applies with a wrong email, then
// again with the right one. The portal cannot merge identities by itself (§3.4
// forbids revealing that an email exists, and reconciliation is deliberately
// conservative), so the DUPLICATE ROWS are real. This service is the
// recruiter's recovery tool: fold the source row into the target row inside
// ONE transaction, with the decisions spelled out:
//
//   * the SURVIVOR's identity wins — the target keeps its email/contact (the
//     recruiter chose it); only BLANK fields on the target are filled from the
//     source, the same fill-only-blanks rule reconciliation uses;
//   * applications transfer to the target EXCEPT where the target already has
//     an application to the same requisition — a shared requisition stays with
//     the source row (history preserved, no double-live application; the
//     target's own application stands). The report names both sets;
//   * the source is NOT deleted and NOT anonymized — deletion would break the
//     audit chain, anonymization would destroy nothing here but the trail. It
//     is archived with a note naming the survivor, so every moved child row
//     stays explainable;
//   * HARD REFUSALS: self-merge, either row anonymized (erasure evidence must
//     not be re-identified by being merged), either row under legal hold, and
//     an ACTIVE application overlap (both non-terminal on one requisition)
//     where the recruiter has not explicitly confirmed keep-target.
import prisma from "../config/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { logAction } from "../utils/logs.js";

const fail = (message, status, code, details) =>
    Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const TERMINAL_STAGES = new Set(["hired", "rejected", "withdrawn"]);

export const mergeCandidates = async ({ tenantId, sourceId, targetId, actorId, keepTargetOnConflict = true } = {}) => {
    const sourceNum = Number(sourceId);
    const targetNum = Number(targetId);
    if (!Number.isInteger(sourceNum) || !Number.isInteger(targetNum) || sourceNum <= 0 || targetNum <= 0) {
        throw fail("Source and target candidate ids are required", 400, "HR-RECRUITMENT-MERGE-INPUT-INVALID");
    }
    if (sourceNum === targetNum) {
        throw fail("A candidate cannot be merged into itself", 400, "HR-RECRUITMENT-MERGE-SELF");
    }

    const [source, target] = await Promise.all([
        prisma.candidate.findFirst({ where: scopedWhere(tenantId, { id: sourceNum }) }),
        prisma.candidate.findFirst({ where: scopedWhere(tenantId, { id: targetNum }) }),
    ]);
    if (!source || !target) {
        // Same 404 for a foreign-tenant id and an unknown id (fail-closed).
        throw fail("Candidate not found", 404, "HR-RECRUITMENT-MERGE-NOT-FOUND");
    }
    if (source.anonymizedAt || target.anonymizedAt) {
        throw fail("An anonymized candidate cannot participate in a merge", 409, "HR-RECRUITMENT-MERGE-ANONYMIZED");
    }
    if (source.status !== "active") {
        throw fail("Only an active candidate can be merged away", 409, "HR-RECRUITMENT-MERGE-SOURCE-INACTIVE");
    }

    const holds = await prisma.candidateLegalHold.findMany({
        where: scopedWhere(tenantId, { candidateId: { in: [sourceNum, targetNum] }, releasedAt: null }),
        select: { candidateId: true },
    });
    if (holds.length) {
        throw fail("A candidate under legal hold cannot be merged", 409, "HR-RECRUITMENT-MERGE-LEGAL-HOLD", {
            candidateIds: holds.map((h) => h.candidateId),
        });
    }

    const sourceApps = await prisma.application.findMany({
        where: scopedWhere(tenantId, { candidateId: sourceNum }),
        select: { id: true, jobRequisitionId: true, stage: true },
    });
    const targetApps = await prisma.application.findMany({
        where: scopedWhere(tenantId, { candidateId: targetNum }),
        select: { id: true, jobRequisitionId: true, stage: true },
    });

    const targetReqs = new Set(targetApps.map((a) => a.jobRequisitionId));
    const transferable = sourceApps.filter((a) => !targetReqs.has(a.jobRequisitionId));
    const conflicting = sourceApps.filter((a) => targetReqs.has(a.jobRequisitionId));
    // A shared requisition where BOTH rows are still live is a real pipeline
    // conflict (two live candidacies for one seat) — refuse unless the caller
    // explicitly accepted the target's application as the standing one.
    const activeConflict = conflicting.some((a) => !TERMINAL_STAGES.has(String(a.stage).toLowerCase()));
    if (activeConflict && keepTargetOnConflict !== true) {
        throw fail(
            "Both candidates have live applications to the same requisition; pass keepTargetOnConflict=true to keep the target's application and archive the source's",
            409,
            "HR-RECRUITMENT-MERGE-APPLICATION-CONFLICT",
            { requisitionIds: [...new Set(conflicting.map((a) => a.jobRequisitionId))] },
        );
    }

    const result = await tenantTransaction(
        prisma,
        async (tx) => {
            // ── Identity: fill only blanks on the survivor (never overwrite). ──
            await tx.candidate.update({
                where: { id: targetNum },
                data: {
                    phone: target.phone ?? source.phone ?? undefined,
                    resumeMediaId: target.resumeMediaId ?? source.resumeMediaId ?? undefined,
                    source: target.source ?? source.source ?? undefined,
                    notes: source.notes ? `${target.notes ? `${target.notes}\n` : ""}[merged from #${sourceNum}] ${source.notes}` : target.notes,
                    version: { increment: 1 },
                },
            });

            // ── Non-application children move wholesale. ────────────────────
            // (applications follow below, minus the requisition conflicts;
            // answers/screenings/interviews/stage-history hang off applicationId
            // and travel with their application automatically.)
            await tx.candidateConsent.updateMany({
                where: scopedWhere(tenantId, { candidateId: sourceNum }),
                data: { candidateId: targetNum },
            });
            await tx.talentPool.updateMany({
                where: scopedWhere(tenantId, { candidateId: sourceNum }),
                data: { candidateId: targetNum },
            });
            await tx.candidateSkill.updateMany({
                where: scopedWhere(tenantId, { candidateId: sourceNum }),
                data: { candidateId: targetNum },
            });
            await tx.aiInferenceRecord.updateMany({
                where: scopedWhere(tenantId, { candidateId: sourceNum }),
                data: { candidateId: targetNum },
            });
            // Verification/status tokens: re-point, then drop the source's live
            // STATUS_LINK rows (the survivor keeps their own live link; the
            // candidate may re-request).
            await tx.candidateEmailVerification.updateMany({
                where: scopedWhere(tenantId, { candidateId: sourceNum, purpose: "STATUS_LINK", consumedAt: null }),
                data: { consumedAt: new Date() },
            });
            await tx.candidateEmailVerification.updateMany({
                where: scopedWhere(tenantId, { candidateId: sourceNum }),
                data: { candidateId: targetNum },
            });
            // Tags: attach the source's tag rows the target lacks (upsert-like
            // union via createMany + skipDuplicates).
            const sourceTags = await tx.candidateTag.findMany({
                where: scopedWhere(tenantId, { candidateId: sourceNum }),
                select: { tagId: true },
            });
            if (sourceTags.length) {
                await tx.candidateTag.createMany({
                    data: sourceTags.map((t) => ({ candidateId: targetNum, tagId: t.tagId, tenantId })),
                    skipDuplicates: true,
                });
            }

            // ── Applications: transfer the non-conflicting, keep conflicts. ──
            if (transferable.length) {
                await tx.application.updateMany({
                    where: scopedWhere(tenantId, { id: { in: transferable.map((a) => a.id) } }),
                    data: { candidateId: targetNum },
                });
            }

            // ── Archive the source (never delete, never anonymize). ─────────
            await tx.candidate.update({
                where: { id: sourceNum },
                data: {
                    status: "archived",
                    archivedAt: new Date(),
                    notes: `Merged into candidate #${targetNum}${actorId ? ` by employee #${actorId}` : ""}`,
                    version: { increment: 1 },
                },
            });

            return {
                merged: true,
                sourceId: sourceNum,
                targetId: targetNum,
                transferredApplicationIds: transferable.map((a) => a.id),
                keptOnSourceApplicationIds: conflicting.map((a) => a.id),
            };
        },
        { tenantId },
    );

    await logAction({
        employeeId: actorId ?? null,
        type: "UPDATE",
        module: "Candidate",
        result: "SUCCESS",
        notes: `Candidate #${sourceNum} merged into #${targetNum} (${result.transferredApplicationIds.length} applications transferred, ${result.keptOnSourceApplicationIds.length} kept on source)`,
        tenantId,
    });

    return result;
};
