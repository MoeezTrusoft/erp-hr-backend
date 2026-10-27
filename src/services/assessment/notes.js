import { z } from "zod";
import { AssessmentRef, code } from "@trusoft/contracts/assessment";
import { run, config, assignmentAccess, hash, json } from "./base.js";
import { brief, recordDraft } from "./evidence.js";
export const NoteCommand = z
  .object({ assessmentRef: AssessmentRef, taskCode: code })
  .strict();
export async function draftNote(raw) {
  const input = NoteCommand.parse(raw);
  return run("hr.assessment.update", async (tx, env) => {
    const a = await tx.assessmentAssignment.findFirst({
      where: { tenantId: env.tenantId, id: input.assessmentRef },
    });
    assignmentAccess(env, a, true);
    const task = a.profileSnapshot.tasks.find(
        (t) => t.taskCode === input.taskCode,
      ),
      cfg = await config(tx, env.tenantId);
    if (!task || !cfg.policy.noteDraftFamilies.includes(task.familyCode))
      return { available: false };
    const b = await brief(tx, env, a, task.taskCode),
      evidence = b.evidence
        .filter(
          (e) =>
            e.scanState === "CLEAN" &&
            !e.withdrawnAt &&
            !e.integrityFlags.length,
        )
        .slice(0, 5);
    if (!evidence.length) return { available: false };
    const key = `${a.id}:${a.revisionNo}:${task.taskCode}:${b.digest}`;
    const old = await tx.assessmentIntegration.findUnique({
      where: {
        tenantId_kind_key: { tenantId: env.tenantId, kind: "NOTE_DRAFT", key },
      },
    });
    if (old) return old.payload;
    // Deterministic source facts only. No judgment, score or provider dependency.
    const draft = await recordDraft(tx, env, a.id, {
      text: evidence
        .map(
          (e) =>
            `Case ${e.caseRef}: ${e.method.replaceAll("_", " ").toLowerCase()}; recorded outcome ${e.qualityStatus.replaceAll("_", " ").toLowerCase()}. Verify and describe ${a.employeeCode}'s own contribution before retaining this note.`,
        )
        .join("\n"),
      evidenceRefs: evidence.map((e) => e.id),
      modelVersion: "RULES-1",
      promptVersion: "EVIDENCE-FACTS-1",
    });
    if (!draft.available) return draft;
    const payload = {
      ...draft,
      version: 1,
      taskCode: task.taskCode,
      briefDigest: b.digest,
      digest: hash(draft),
    };
    await tx.assessmentIntegration.create({
      data: {
        tenantId: env.tenantId,
        employeeCode: a.employeeCode,
        kind: "NOTE_DRAFT",
        key,
        sourceRef: a.id,
        status: "SUGGESTED",
        payload: json(payload),
      },
    });
    return payload;
  });
}
