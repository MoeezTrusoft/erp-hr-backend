import { assessmentAnalytics } from "./analytics.js";
import { testReport } from "./test-report.js";
import { run, load, interview, event, fail } from "./base.js";
import { transitionApplicationStageInTransaction } from "../applicationWorkflow.service.js";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import { interviewCancelledEvent } from "../hrEvents.js";
export const resultGet = (input) =>
  run("hr.recruitment.read", async (tx, env) => {
    const r = await load(tx, env, "candidateTestResult", input.id);
    const i = await interview(tx, env, input.interviewId ?? r.interviewId);
    if (i.id !== r.interviewId && i.assessmentResultId !== r.id)
      fail("Result not found", 404);
    const report = await testReport(tx, env.tenantId, r, i);
    if (!report) fail("Result not found", 404);
    return report;
  });
export const resultsList = (input) =>
  run("hr.recruitment.read", async (tx, env) => {
    const where = {
        tenantId: env.tenantId,
        ...(input.applicationId ? { applicationId: input.applicationId } : {}),
        ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      },
      rows = await tx.candidateTestResult.findMany({
        where,
        orderBy: { id: "asc" },
        take: input.limit ?? 50,
      }),
      items = [];
    for (const r of rows) {
      try {
        await interview(tx, env, r.interviewId);
        items.push(r);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    return {
      items,
      nextCursor: rows.length === (input.limit ?? 50) ? rows.at(-1).id : null,
    };
  });
export async function decideResult(tx, env, r, input) {
  const i = await interview(tx, env, r.interviewId, { lock: true });
  if (!["ORG", "MANAGED"].includes(env.scope.level))
    fail("A recruiter or the hiring manager must decide", 403);
  if (r.decision) {
    if (r.decision === input.decision && r.decisionReason === input.reason)
      return r;
    fail("This result has already been decided", 409);
  }
  if (!["FAILED", "REVIEW", "INCOMPLETE"].includes(r.band))
    fail("This result already permits the interview");
  if (input.decision === "PROCEED" && r.band !== "REVIEW")
    fail("Use Override with a reason for a failed or incomplete result");
  let status = {
    PROCEED: "OVERRIDDEN",
    OVERRIDE: "OVERRIDDEN",
    RELEASE: "RELEASED",
    RETEST: "CHECKED_IN",
  }[input.decision];
  if (!status) fail("Unsupported result decision");
  if (input.decision === "RELEASE") {
    if (i.status !== "SCHEDULED")
      fail("Only a scheduled interview can be released");
    await transitionApplicationStageInTransaction(
      {
        id: i.applicationId,
        tenantId: env.tenantId,
        targetStage: "rejected",
        reason:
          r.band === "REVIEW"
            ? "ASSESSMENT_INTEGRITY"
            : "ASSESSMENT_BELOW_THRESHOLD",
        actorId: env.who.id,
        source: "onsite-assessment",
      },
      tx,
    );
    await tx.interviewLifecycleEvent.create({
      data: {
        tenantId: env.tenantId,
        interviewId: i.id,
        eventType: "CANCELLED",
        reasonCode: "ASSESSMENT_NOT_PASSED",
        notes: input.reason,
        previousScheduledAt: i.scheduledAt,
        actorId: env.who.id,
      },
    });
    await enqueueHrDomainEvent(
      tx,
      interviewCancelledEvent(
        { ...i, candidateId: i.application.candidateId },
        { actorId: env.who.id },
        {
          reasonCode: "ASSESSMENT_NOT_PASSED",
          interviewerIds: i.interviewers.map((p) => p.employeeId),
        },
      ),
    );
  }
  await tx.interview.update({
    where: { id: i.id },
    data: {
      assessmentStatus: status,
      ...(input.decision === "RELEASE"
        ? { status: "CANCELLED", calendarSyncStatus: "PENDING" }
        : {}),
    },
  });
  const row = await tx.candidateTestResult.update({
    where: { id: r.id },
    data: {
      decision: input.decision,
      decidedById: env.who.id,
      decisionReason: input.reason,
      decidedAt: env.now,
    },
  });
  await event(tx, env, "test_result_decided", {
    applicationId: r.applicationId,
    interviewId: i.id,
    sessionId: r.sessionId,
    resultId: r.id,
  });
  return row;
}
export const resultDecide = (input) =>
  run("hr.recruitment.update", async (tx, env) =>
    decideResult(
      tx,
      env,
      await load(tx, env, "candidateTestResult", input.id, { lock: true }),
      input,
    ),
  );
export const resultWaive = (input) =>
  run("hr.recruitment.update", async (tx, env) => {
    const i = await interview(tx, env, input.interviewId, { lock: true });
    if (!["ORG", "MANAGED"].includes(env.scope.level))
      fail("A recruiter or the hiring manager must waive", 403);
    if (
      i.status !== "SCHEDULED" ||
      [
        "NOT_REQUIRED",
        "PASSED",
        "BORDERLINE",
        "RELEASED",
        "OVERRIDDEN",
      ].includes(i.assessmentStatus)
    )
      fail("This assessment cannot be waived");
    if (i.assessmentStatus === "WAIVED")
      return { interviewId: i.id, assessmentStatus: "WAIVED" };
    await tx.candidateTestSession.updateMany({
      where: {
        tenantId: env.tenantId,
        interviewId: i.id,
        status: { in: ["ISSUED", "IN_PROGRESS", "PAUSED"] },
      },
      data: {
        status: "VOIDED",
        sessionCodeHash: null,
        accessTokenHash: null,
        submittedAt: env.now,
      },
    });
    await tx.interview.update({
      where: { id: i.id },
      data: { assessmentStatus: "WAIVED" },
    });
    await tx.interviewLifecycleEvent.create({
      data: {
        tenantId: env.tenantId,
        interviewId: i.id,
        eventType: "ASSESSMENT_WAIVED",
        reasonCode: "WAIVED",
        notes: input.reason,
        actorId: env.who.id,
      },
    });
    await event(tx, env, "test_result_decided", {
      applicationId: i.applicationId,
      interviewId: i.id,
    });
    return {
      interviewId: i.id,
      assessmentStatus: "WAIVED",
      reason: input.reason,
    };
  });
export const testAnalytics = (input) =>
  run("hr.recruitment.read", async (tx, env) => {
    if (env.scope.level !== "ORG") fail("HR analytics access required", 403);
    return assessmentAnalytics(tx, env.tenantId, input);
  });
