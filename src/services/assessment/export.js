import { z } from "zod";
import { AssessmentRef } from "@trusoft/contracts/assessment";
import { run, assignmentAccess, fail, audit, json } from "./base.js";
export const ExportCommand = z
  .object({ assessmentRef: AssessmentRef, revisionRef: AssessmentRef })
  .strict();
export async function exportAssessment(raw) {
  const input = ExportCommand.parse(raw);
  return run("hr.assessment.export", async (tx, env) => {
    const a = await tx.assessmentAssignment.findFirst({
      where: { tenantId: env.tenantId, id: input.assessmentRef },
    });
    assignmentAccess(env, a);
    const r = await tx.assessmentRevision.findFirst({
      where: {
        tenantId: env.tenantId,
        id: input.revisionRef,
        assessmentRef: a.id,
        state: { in: ["APPROVED", "PUBLISHED", "REVOKED"] },
      },
    });
    if (!r)
      fail(
        "EXPORT_REVISION",
        "Select an approved immutable assessment revision",
      );
    const signatures = await tx.assessmentSignOff.findMany({
      where: {
        tenantId: env.tenantId,
        assessmentRef: a.id,
        revisionNo: r.revisionNo,
      },
      select: {
        employeeCode: true,
        action: true,
        attestation: true,
        createdAt: true,
        digest: true,
      },
    });
    const output = json({
      format: "HR_TASK_ASSESSMENT_1",
      companyUuid: env.tenantId,
      employeeCode: a.employeeCode,
      assessmentRef: a.id,
      revisionRef: r.id,
      digest: r.digest,
      state: r.state,
      snapshot: r.snapshot,
      signatures,
    });
    await audit(tx, env, "ASSESSMENT_EXPORT", a.id, input, {
      digest: r.digest,
    });
    return output;
  });
}
