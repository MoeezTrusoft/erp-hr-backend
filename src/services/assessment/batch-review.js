import { run, fail } from "./base.js";
import { workflow } from "./workflow.js";
export async function approveBatch(input) {
  await run("hr.assessment.approve", async (tx, env) => {
    if (
      new Set(input.items.map((i) => i.assessmentRef)).size !==
      input.items.length
    )
      fail("DUPLICATE_REVIEW", "Select each assessment only once");
    for (const item of input.items) {
      const a = await tx.assessmentAssignment.findFirst({
        where: {
          tenantId: env.tenantId,
          id: item.assessmentRef,
          reviewerCode: env.who.employeeCode,
          state: "UNDER_REVIEW",
        },
      });
      if (!a || a.version !== item.expectedVersion)
        fail(
          "REVIEW_PACKET_CHANGED",
          "Reload the assigned review packets",
          409,
        );
      const revision = await tx.assessmentRevision.findFirst({
        where: {
          tenantId: env.tenantId,
          assessmentRef: a.id,
          revisionNo: a.revisionNo,
        },
      });
      if (
        !revision ||
        revision.reviewTier !== "BATCH" ||
        revision.digest !== item.revisionDigest ||
        revision.snapshot.checks.length
      )
        fail(
          "FULL_REVIEW_REQUIRED",
          "Batch approval is limited to unsampled routine packets with passing checks",
        );
    }
  });
  const results = [];
  for (const item of input.items) {
    try {
      const a = await workflow({
        ...item,
        action: "APPROVE",
        declaration: input.declaration,
      });
      results.push({ assessmentRef: a.id, status: "APPROVED" });
    } catch (error) {
      if (!error.status) throw error;
      results.push({
        assessmentRef: item.assessmentRef,
        status: "REVIEW_REQUIRED",
        code: error.code,
        message: error.message,
      });
    }
  }
  return {
    results,
    notice:
      "Each successful review has its own immutable approval. Refresh any changed packet before retrying.",
  };
}
