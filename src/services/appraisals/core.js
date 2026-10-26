import { randomUUID } from "node:crypto";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import {
  openReviewApproval,
  completeReviewApproval,
} from "./approval-bridge.js";
import * as C from "@trusoft/contracts/performance-appraisals";
import { cycleMetrics } from "./metrics.js";
import {
  scoreReview,
  addWorkingDays,
  localDate,
} from "@trusoft/contracts/performance-appraisal-rules";
import {
  run,
  fail,
  permit,
  expected,
  person,
  review,
  independent,
  audit,
  sign,
  updateReview,
  json,
  digest,
} from "./base.js";

export const configure = (raw) => {
  const i = C.Configuration.parse(raw);
  return run(
    "configure",
    i,
    "hr.performance.configure",
    async (tx, e) => {
      if (e.config) expected(e.config, i.expectedVersion);
      else if (i.expectedVersion !== 0)
        fail("VERSION_CONFLICT", "Configuration does not yet exist", 412);
      const row = await tx.perfConfiguration.upsert({
        where: { tenantId: e.tenantId },
        create: {
          tenantId: e.tenantId,
          version: 1,
          coreEnabled: i.coreEnabled,
          policy: i.policy,
        },
        update: {
          version: { increment: 1 },
          coreEnabled: i.coreEnabled,
          policy: i.policy,
        },
      });
      await audit(tx, e, "CONFIGURE", e.tenantId, row.version, i);
      return { version: row.version, coreEnabled: row.coreEnabled };
    },
    { configuration: true },
  );
};
export const templateCreate = (raw) => {
  const i = C.TemplateCreate.parse(raw);
  return run(
    "template.create",
    i,
    "hr.performance.configure",
    async (tx, e) => {
      const row = await tx.perfTemplateVersion.create({
        data: {
          tenantId: e.tenantId,
          name: i.name,
          rubric: i.rubric,
          createdBy: e.who.id,
        },
      });
      await audit(tx, e, "TEMPLATE_CREATE", row.id, 0, i);
      return { id: row.id, version: 0, status: row.status };
    },
  );
};
export const templatePublish = (raw) => {
  const i = C.TemplatePublish.parse(raw);
  return run(
    "template.publish",
    i,
    "hr.performance.configure",
    async (tx, e) => {
      const row = await tx.perfTemplateVersion.findFirst({
        where: { id: i.id, tenantId: e.tenantId },
      });
      if (!row) fail("NOT_FOUND", "Template not found", 404);
      expected(row, i.expectedVersion);
      if (row.status !== "DRAFT")
        fail("STATE_CONFLICT", "Template already published", 409);
      C.Rubric.parse(row.rubric);
      await tx.perfTemplateVersion.update({
        where: { id: row.id },
        data: {
          status: "PUBLISHED",
          publishedAt: e.now,
          version: { increment: 1 },
        },
      });
      await audit(tx, e, "TEMPLATE_PUBLISH", row.id, row.version + 1, i);
      return { id: row.id, version: row.version + 1, status: "PUBLISHED" };
    },
  );
};
export const cycleCreate = (raw) => {
  const i = C.CycleCreate.parse(raw);
  return run(
    "cycle.create",
    i,
    "hr.performance.cycle.manage",
    async (tx, e) => {
      const template = await tx.perfTemplateVersion.findFirst({
        where: { id: i.templateId, tenantId: e.tenantId, status: "PUBLISHED" },
      });
      if (!template) fail("NOT_FOUND", "Published template not found", 404);
      const row = await tx.perfCycle.create({
        data: {
          tenantId: e.tenantId,
          name: i.name,
          templateId: i.templateId,
          policy: e.config.policy,
          timezone: i.timezone,
          periodStart: i.periodStart,
          periodEnd: i.periodEnd,
          selfDue: new Date(i.selfDue),
          managerDue: new Date(i.managerDue),
        },
      });
      await audit(tx, e, "CYCLE_CREATE", row.id, 0, i);
      return { id: row.id, version: 0, status: row.status };
    },
  );
};
export const cycleLaunch = (raw) => {
  const i = C.CycleLaunch.parse(raw);
  return run(
    "cycle.launch",
    i,
    "hr.performance.cycle.manage",
    async (tx, e) => {
      const row = await tx.perfCycle.findFirst({
        where: { id: i.id, tenantId: e.tenantId },
      });
      if (!row) fail("NOT_FOUND", "Cycle not found", 404);
      expected(row, i.expectedVersion);
      if (row.status !== "DRAFT")
        fail("STATE_CONFLICT", "Cycle is already launched", 409);
      if (+row.selfDue <= +e.now)
        fail("VALIDATION_FAILED", "Self deadline must be in the future");
      const ids = [...new Set(i.employeeIds)];
      const employees = await tx.employee.findMany({
        where: { tenant_id: e.tenantId, id: { in: ids } },
      });
      if (employees.length !== ids.length)
        fail("NOT_FOUND", "An eligible employee was not found", 404);
      const managerIds = [...new Set(employees.map((p) => p.managerId))];
      const managers = await tx.employee.findMany({
        where: {
          tenant_id: e.tenantId,
          id: { in: managerIds.filter(Boolean) },
        },
      });
      const active = (p) =>
        p &&
        !/inactive|terminated|exited|offboard|separated/i.test(
          `${p.status} ${p.employement_status}`,
        );
      if (
        employees.some(
          (p) =>
            !active(p) ||
            p.id === p.managerId ||
            !active(managers.find((m) => m.id === p.managerId)),
        )
      )
        fail(
          "ELIGIBILITY_INVALID",
          "Each participant requires an active independent manager",
        );
      const data = employees.map((p) => ({
        tenantId: e.tenantId,
        cycleId: row.id,
        employeeId: p.id,
        managerId: p.managerId,
        snapshot: json({
          employeeId: p.id,
          employeeCode: p.employee_code,
          managerId: p.managerId,
          positionId: p.positionId,
          businessUnitId: p.businessUnitId,
          gradeLevelId: p.gradeLevelId,
          hrisVersion: p.version,
          at: e.now,
        }),
        originalSelfDue: row.selfDue,
        originalManagerDue: row.managerDue,
      }));
      for (let offset = 0; offset < data.length; offset += 250)
        await tx.perfParticipant.createMany({
          data: data.slice(offset, offset + 250),
        });
      await tx.perfCycle.update({
        where: { id: row.id },
        data: {
          status: "ACTIVE",
          launchedAt: e.now,
          version: { increment: 1 },
        },
      });
      const runId = randomUUID();
      const launch = await tx.perfLaunchRun.create({
        data: {
          id: runId,
          tenantId: e.tenantId,
          cycleId: row.id,
          total: ids.length,
          jobId: "launch-" + runId,
        },
      });
      await audit(tx, e, "CYCLE_LAUNCH", row.id, row.version + 1, i, {
        eligible: ids.length,
      });
      return {
        id: row.id,
        version: row.version + 1,
        status: "ACTIVE",
        jobId: launch.jobId,
        launchRunId: launch.id,
        eligible: ids.length,
      };
    },
  );
};
export const launchControl = (raw) => {
  const i = C.LaunchControl.parse(raw);
  return run(
    "launch.control",
    i,
    "hr.performance.cycle.manage",
    async (tx, e) => {
      const row = await tx.perfLaunchRun.findFirst({
        where: { id: i.id, tenantId: e.tenantId },
      });
      if (!row) fail("NOT_FOUND", "Launch run not found", 404);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${e.tenantId + ":appraisal-launch:" + row.cycleId},0))`;
      expected(row, i.expectedVersion);
      if (["SUCCEEDED", "CANCELLED"].includes(row.state))
        fail("STATE_CONFLICT", "Launch is already finished", 409);
      if (i.action === "CANCEL" && row.processed !== 0)
        fail(
          "LAUNCH_ALREADY_STARTED",
          "Pause this launch to preserve the reviews already created",
          409,
        );
      const state = { PAUSE: "PAUSED", RESUME: "QUEUED", CANCEL: "CANCELLED" }[
        i.action
      ];
      const result = await tx.perfLaunchRun.update({
        where: { id: row.id },
        data: {
          state,
          version: { increment: 1 },
          completedAt: state === "CANCELLED" ? e.now : null,
        },
      });
      if (state === "CANCELLED")
        await tx.perfCycle.update({
          where: { id: row.cycleId },
          data: { status: "ARCHIVED", version: { increment: 1 } },
        });
      await audit(tx, e, "LAUNCH_" + i.action, row.id, result.version, i, {
        cycleId: row.cycleId,
        processed: row.processed,
      });
      return { id: result.id, version: result.version, state: result.state };
    },
  );
};
export async function launchBatch(tx, tenantId, cycleId, batchSize = 250) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 250)
    fail("VALIDATION_FAILED", "Launch batch size must be between 1 and 250");
  const cycle = await tx.perfCycle.findFirst({
    where: { id: cycleId, tenantId },
  });
  if (!cycle || cycle.status !== "ACTIVE") return { created: 0, done: true };
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":appraisal-launch:" + cycleId},0))`;
  const launch = await tx.perfLaunchRun.findFirst({
    where: { tenantId, cycleId },
  });
  if (!launch)
    fail("LAUNCH_RUN_REQUIRED", "The cycle has no durable launch run", 409);
  if (["PAUSED", "CANCELLED", "SUCCEEDED"].includes(launch.state))
    return { created: 0, done: true };
  const rows = await tx.perfParticipant.findMany({
    where: { tenantId, cycleId, inclusionState: "INCLUDED" },
    orderBy: { id: "asc" },
    skip: cycle.launchCursor,
    take: Math.min(250, batchSize),
  });
  for (const p of rows)
    await tx.perfReview.upsert({
      where: { tenantId_participantId: { tenantId, participantId: p.id } },
      create: {
        tenantId,
        participantId: p.id,
        cycleId,
        employeeId: p.employeeId,
        managerId: p.managerId,
        selfDue: p.originalSelfDue,
        managerDue: p.originalManagerDue,
      },
      update: {},
    });
  const changed = await tx.perfCycle.updateMany({
    where: { id: cycleId, tenantId, launchCursor: cycle.launchCursor },
    data: { launchCursor: { increment: rows.length } },
  });
  if (changed.count !== 1) fail("STATE_CONFLICT", "Launch cursor changed", 409);
  const processed = launch.processed + rows.length;
  const done = processed === launch.total;
  if (processed > launch.total || (!rows.length && !done))
    fail(
      "LAUNCH_RECONCILIATION_FAILED",
      "Frozen roster and launch counters disagree",
      409,
    );
  if (rows.length)
    await tx.perfLaunchBatch.create({
      data: {
        tenantId,
        runId: launch.id,
        batchNo: launch.batchNo + 1,
        firstParticipantId: rows[0].id,
        lastParticipantId: rows.at(-1).id,
        count: rows.length,
        digest: digest(rows.map((p) => ({ id: p.id, snapshot: p.snapshot }))),
      },
    });
  await tx.perfLaunchRun.update({
    where: { id: launch.id },
    data: {
      processed,
      batchNo: launch.batchNo + (rows.length ? 1 : 0),
      state: done ? "SUCCEEDED" : "RUNNING",
      version: { increment: 1 },
      completedAt: done ? new Date() : null,
    },
  });
  if (done) {
    const queued = await enqueueHrDomainEvent(tx, {
      tenantId,
      eventName: "hr.performance.cycle.launched.v1",
      actorId: "svc:hr-appraisals",
      actorType: "service",
      aggregateType: "AppraisalLaunch",
      aggregateId: launch.id,
      correlationId: launch.id,
      payload: {
        aggregateId: launch.id,
        aggregateVersion: launch.version + 1,
        cycleId,
        schemaVersion: 1,
      },
    });
    if (!queued)
      fail(
        "OUTBOX_UNAVAILABLE",
        "Launch completion event could not be recorded",
        503,
      );
  }
  return {
    created: rows.length,
    done,
    processed,
    total: launch.total,
    jobId: launch.jobId,
  };
}
export const responseSave = (raw) => {
  const i = C.ResponseSave.parse(raw);
  return run(
    "response.save",
    i,
    "hr.performance.response.write",
    async (tx, e) => {
      const { row, cycle, self, manager } = await review(tx, e, i.id, {
        write: true,
        correction: true,
      });
      expected(row, i.expectedVersion);
      if (i.role === "SELF" ? !self : !manager)
        fail("FORBIDDEN", "Only the assigned response author can edit", 403);
      if (
        (i.role === "SELF" && row.state !== "SELF_OPEN") ||
        (i.role === "MANAGER" &&
          !["SELF_OPEN", "SELF_SUBMITTED", "CORRECTION_OPEN"].includes(
            row.state,
          ))
      )
        fail("STATE_CONFLICT", "This response is no longer editable", 409);
      const template = await tx.perfTemplateVersion.findFirst({
        where: { id: cycle.templateId, tenantId: e.tenantId },
      });
      const ids = i.answers.map((a) => a.criterionId);
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !template.rubric.criteria.some((c) => c.id === id))
      )
        fail("VALIDATION_FAILED", "Unknown or duplicate answer");
      const evidenceIds = [...new Set(i.answers.flatMap((a) => a.evidenceIds))];
      const count = await tx.perfEvidenceLink.count({
        where: {
          tenantId: e.tenantId,
          reviewId: row.id,
          id: { in: evidenceIds },
        },
      });
      if (count !== evidenceIds.length)
        fail("NOT_FOUND", "Evidence does not belong to this review", 404);
      const prior = await tx.perfResponse.findFirst({
        where: {
          tenantId: e.tenantId,
          reviewId: row.id,
          role: i.role,
          authorId: e.who.id,
        },
        orderBy: { responseNo: "desc" },
      });
      if (prior && !prior.submittedAt)
        await tx.perfResponse.update({
          where: { id: prior.id },
          data: { answers: i.answers },
        });
      else
        await tx.perfResponse.create({
          data: {
            tenantId: e.tenantId,
            reviewId: row.id,
            role: i.role,
            authorId: e.who.id,
            responseNo: (prior?.responseNo || 0) + 1,
            answers: i.answers,
          },
        });
      const next = await updateReview(tx, e, row, {});
      await audit(tx, e, "RESPONSE_SAVE", row.id, next.version, i);
      return { id: row.id, version: next.version, state: row.state };
    },
  );
};
async function submittedResponse(tx, e, row, role, authorId) {
  const response = await tx.perfResponse.findFirst({
    where: { tenantId: e.tenantId, reviewId: row.id, role, authorId },
    orderBy: { responseNo: "desc" },
  });
  if (!response)
    fail("VALIDATION_FAILED", "Save a complete response before submission");
  return response;
}
export const transition = (raw) => {
  const i = C.ReviewTransition.parse(raw);
  return run("review.transition", i, "hr.performance.response.write", (tx, e) =>
    transitionInTransaction(tx, e, i),
  );
};
export async function transitionInTransaction(tx, e, i) {
  const { row, cycle, self, manager } = await review(tx, e, i.id, {
    write: i.action !== "ACKNOWLEDGE",
    correction: true,
  });
  expected(row, i.expectedVersion);
  const openAppeal = await tx.perfAppeal.findFirst({
    where: { tenantId: e.tenantId, reviewId: row.id, status: "OPEN" },
  });
  if (openAppeal && !["ACKNOWLEDGE"].includes(i.action))
    fail(
      "APPEAL_HOLD",
      "Resolve the open appeal before changing this review",
      409,
    );
  const template = await tx.perfTemplateVersion.findFirst({
    where: { id: cycle.templateId, tenantId: e.tenantId },
  });
  const data = {};
  const state = (...allowed) => {
    if (!allowed.includes(row.state))
      fail(
        "STATE_CONFLICT",
        "Action is not available in this review state",
        409,
      );
  };
  if (i.action === "SUBMIT_SELF" || i.action === "SUBMIT_MANAGER") {
    const role = i.action === "SUBMIT_SELF" ? "SELF" : "MANAGER";
    if (role === "SELF" ? !self : !manager)
      fail("FORBIDDEN", "Only the assigned author can submit", 403);
    if (role === "SELF") state("SELF_OPEN");
    else {
      state("SELF_SUBMITTED", "SELF_OPEN", "CORRECTION_OPEN");
      if (row.state === "SELF_OPEN" && !row.selfWaiver)
        fail(
          "SELF_RESPONSE_REQUIRED",
          "Self response or an HR waiver is required",
          409,
        );
    }
    const response = await submittedResponse(tx, e, row, role, e.who.id);
    if (response.submittedAt)
      fail("STATE_CONFLICT", "Response is already submitted", 409);
    const score = scoreReview(template.rubric, response.answers, {
      requireEvidence: cycle.policy.requireEvidence,
    });
    await tx.perfResponse.update({
      where: { id: response.id },
      data: { submittedAt: e.now },
    });
    data.state =
      role === "SELF"
        ? "SELF_SUBMITTED"
        : cycle.policy.seniorApprovalRequired
          ? "APPROVAL_PENDING"
          : "CALIBRATION_READY";
    if (role === "MANAGER") {
      const peerRound = await tx.perfPeerRound.findFirst({
        where: { tenantId: e.tenantId, reviewId: row.id },
      });
      if (peerRound?.state === "OPEN")
        fail(
          "PEER_ROUND_OPEN",
          "Close the peer feedback round before submitting the manager review",
          409,
        );
      const selfResponse = await tx.perfResponse.findFirst({
        where: {
          tenantId: e.tenantId,
          reviewId: row.id,
          role: "SELF",
          submittedAt: { not: null },
        },
        orderBy: { responseNo: "desc" },
      });
      const evidence = await tx.perfEvidenceLink.findMany({
        where: { tenantId: e.tenantId, reviewId: row.id },
        orderBy: { id: "asc" },
      });
      const content = json({
        templateId: template.id,
        rubric: template.rubric,
        policy: cycle.policy,
        selfResponse: selfResponse?.answers ?? null,
        selfWaiver: row.selfWaiver,
        managerResponse: response.answers,
        peerSummary: peerRound?.summary ?? null,
        evidence,
      });
      const revision = await tx.perfReviewRevision.create({
        data: {
          tenantId: e.tenantId,
          reviewId: row.id,
          revisionNo: row.revisionNo + 1,
          predecessorId: row.currentRevisionId,
          content,
          digest: digest(content),
          score,
        },
      });
      data.revisionNo = revision.revisionNo;
      data.currentRevisionId = revision.id;
    }
  } else if (i.action === "WAIVE_SELF") {
    permit(e, "hr.performance.cycle.manage");
    independent(e, row);
    state("SELF_OPEN");
    if (!i.reason)
      fail("REASON_REQUIRED", "An HR exception reason is required");
    data.selfWaiver = i.reason;
  } else if (i.action === "RETURN") {
    permit(e, "hr.performance.approve");
    independent(e, row);
    state("APPROVAL_PENDING", "CALIBRATION_READY", "CALIBRATION_PENDING");
    if (!i.reason) fail("REASON_REQUIRED", "Return reason required");
    data.state = row.releasedRevisionId
      ? "CORRECTION_OPEN"
      : row.selfWaiver
        ? "SELF_OPEN"
        : "SELF_SUBMITTED";
  } else if (i.action === "APPROVE_SENIOR") {
    permit(e, "hr.performance.approve");
    independent(e, row);
    state("APPROVAL_PENDING");
    data.state = "CALIBRATION_READY";
  } else if (i.action === "PROPOSE_CALIBRATION") {
    permit(e, "hr.performance.calibrate");
    independent(e, row);
    state("CALIBRATION_READY");
    if (!i.reason || i.adjustedScore === undefined)
      fail(
        "VALIDATION_FAILED",
        "Score and evidence-based calibration reason required",
      );
    const previous = await tx.perfReviewRevision.findFirst({
      where: { id: row.currentRevisionId, tenantId: e.tenantId },
    });
    const content = {
      ...previous.content,
      calibration: {
        proposedBy: e.who.id,
        previousScore: previous.score.score,
        reason: i.reason,
      },
    };
    const revision = await tx.perfReviewRevision.create({
      data: {
        tenantId: e.tenantId,
        reviewId: row.id,
        revisionNo: row.revisionNo + 1,
        predecessorId: previous.id,
        content,
        digest: digest(content),
        score: {
          ...previous.score,
          score: i.adjustedScore,
          band: [...template.rubric.bands]
            .reverse()
            .find((b) => i.adjustedScore >= b.min)?.label,
          calibrated: true,
        },
        reason: i.reason,
      },
    });
    data.currentRevisionId = revision.id;
    data.revisionNo = revision.revisionNo;
    data.state = "CALIBRATION_PENDING";
  } else if (i.action === "APPROVE_CALIBRATION") {
    permit(e, "hr.performance.calibrate.approve");
    state("CALIBRATION_PENDING");
    const revision = await tx.perfReviewRevision.findFirst({
      where: { id: row.currentRevisionId, tenantId: e.tenantId },
    });
    independent(e, row, [revision.content.calibration.proposedBy]);
    data.state = "CALIBRATED";
  } else if (i.action === "CONFIRM_CALIBRATION") {
    permit(e, "hr.performance.calibrate.approve");
    independent(e, row);
    state("CALIBRATION_READY");
    if (!i.reason)
      fail(
        "REASON_REQUIRED",
        "Record why no calibration adjustment is required",
      );
    data.state = "CALIBRATED";
  } else if (i.action === "RELEASE") {
    permit(e, "hr.performance.release");
    independent(e, row);
    state("CALIBRATED");
    const proposals = await tx.perfSignoff.findMany({
      where: {
        tenantId: e.tenantId,
        reviewId: row.id,
        action: "PROPOSE_CALIBRATION",
      },
    });
    if (proposals.some((s) => s.actorId === e.who.id))
      fail(
        "INDEPENDENT_APPROVER_REQUIRED",
        "Calibration proposer cannot release this outcome",
        403,
      );
    data.state = "RELEASED";
    data.releasedRevisionId = row.currentRevisionId;
    data.releasedAt = e.now;
    data.acknowledgedAt = null;
    data.appealDeadline = addWorkingDays(
      e.now,
      cycle.policy.appealDays,
      cycle.policy,
      cycle.timezone,
    );
  } else if (i.action === "ACKNOWLEDGE") {
    if (!self) fail("FORBIDDEN", "Only the employee can acknowledge", 403);
    state("RELEASED");
    data.state = "ACKNOWLEDGED";
    data.acknowledgedAt = e.now;
  }
  if (
    i.action === "APPROVE_SENIOR" ||
    (i.action === "RETURN" && row.state === "APPROVAL_PENDING")
  )
    await completeReviewApproval(tx, e, row, "SENIOR", i);
  if (i.action === "RELEASE")
    await completeReviewApproval(tx, e, row, "RELEASE", i);
  await sign(tx, e, row, i.action, i);
  const next = await updateReview(tx, e, row, data);
  if (next.state === "APPROVAL_PENDING")
    await openReviewApproval(tx, e, next, "SENIOR");
  if (next.state === "CALIBRATED")
    await openReviewApproval(tx, e, next, "RELEASE");
  await audit(
    tx,
    e,
    i.action === "RELEASE" && row.releasedRevisionId
      ? "CORRECTION_RELEASE"
      : i.action,
    row.id,
    next.version,
    i,
  );
  return {
    id: row.id,
    version: next.version,
    state: next.state,
    revisionId: next.currentRevisionId,
  };
}

export const assignmentChange = (raw) => {
  const i = C.AssignmentChange.parse(raw);
  return run(
    "assignment.change",
    i,
    "hr.performance.cycle.manage",
    async (tx, e) => {
      const { row, employee } = await review(tx, e, i.id, { write: true });
      expected(row, i.expectedVersion);
      if (
        !["SELF_OPEN", "SELF_SUBMITTED", "CORRECTION_OPEN"].includes(row.state)
      )
        fail(
          "STATE_CONFLICT",
          "Return the review before replacing its evaluator",
          409,
        );
      if (employee.managerId !== i.managerId || i.managerId === row.employeeId)
        fail(
          "ASSIGNMENT_INVALID",
          "Replacement must match the current independent HRIS manager",
        );
      await person(tx, e.tenantId, i.managerId);
      const next = await updateReview(tx, e, row, {
        managerId: i.managerId,
        scheduleVersion: row.scheduleVersion + 1,
      });
      await cancelReminderSchedule(tx, e, row);
      await audit(tx, e, "ASSIGNMENT_CHANGE", row.id, next.version, i, {
        previousManagerId: row.managerId,
      });
      return { id: row.id, version: next.version };
    },
  );
};
export const deadlineChange = (raw) => {
  const i = C.DeadlineChange.parse(raw);
  return run(
    "deadline.change",
    i,
    "hr.performance.cycle.manage",
    async (tx, e) => {
      const { row } = await review(tx, e, i.id, { write: true });
      expected(row, i.expectedVersion);
      if (!["SELF_OPEN", "SELF_SUBMITTED"].includes(row.state))
        fail(
          "STATE_CONFLICT",
          "Only open response deadlines can be changed",
          409,
        );
      if (i.selfDue > i.managerDue)
        fail(
          "VALIDATION_FAILED",
          "Manager deadline cannot precede self deadline",
        );
      const next = await updateReview(tx, e, row, {
        selfDue: new Date(i.selfDue),
        managerDue: new Date(i.managerDue),
        scheduleVersion: row.scheduleVersion + 1,
      });
      await cancelReminderSchedule(tx, e, row);
      await audit(tx, e, "DEADLINE_CHANGE", row.id, next.version, i, {
        previousSelfDue: row.selfDue,
        previousManagerDue: row.managerDue,
      });
      return { id: row.id, version: next.version };
    },
  );
};
export const cycleTransition = (raw) => {
  const i = C.CycleTransition.parse(raw);
  return run(
    "cycle.transition",
    i,
    "hr.performance.cycle.manage",
    async (tx, e) => {
      const row = await tx.perfCycle.findFirst({
        where: { tenantId: e.tenantId, id: i.id },
      });
      if (!row) fail("NOT_FOUND", "Cycle not found", 404);
      expected(row, i.expectedVersion);
      const statuses = {
        CALIBRATE: ["ACTIVE", "CALIBRATING"],
        CLOSE: ["CALIBRATING", "CLOSED"],
        ARCHIVE: ["CLOSED", "ARCHIVED"],
      };
      const [from, to] = statuses[i.action];
      if (row.status !== from)
        fail("STATE_CONFLICT", "Cycle transition is unavailable", 409);
      const launch = await tx.perfLaunchRun.findFirst({
        where: { tenantId: e.tenantId, cycleId: row.id },
      });
      if (launch?.state !== "SUCCEEDED")
        fail(
          "LAUNCH_NOT_COMPLETE",
          "Complete the frozen roster launch before advancing the cycle",
          409,
        );
      if (i.action === "CLOSE") {
        const roster = await tx.perfParticipant.count({
          where: {
            tenantId: e.tenantId,
            cycleId: row.id,
            inclusionState: "INCLUDED",
          },
        });
        const finished = await tx.perfReview.count({
          where: {
            tenantId: e.tenantId,
            cycleId: row.id,
            state: { in: ["RELEASED", "ACKNOWLEDGED"] },
          },
        });
        if (roster !== finished)
          fail("CLOSE_NOT_READY", "Unfinished reviews prevent closure", 409);
      }
      await tx.perfCycle.update({
        where: { id: row.id },
        data: {
          status: to,
          version: { increment: 1 },
          ...(to === "CLOSED"
            ? {
                closedAt: e.now,
                closingSnapshot: json(
                  await cycleMetrics(tx, e.tenantId, row.id, e.now),
                ),
              }
            : {}),
        },
      });
      await audit(tx, e, "CYCLE_" + i.action, row.id, row.version + 1, i);
      return { id: row.id, version: row.version + 1, status: to };
    },
  );
};
export const appeal = (raw) => {
  const i = C.AppealCommand.parse(raw);
  return run("appeal", i, "hr.performance.appeal", async (tx, e) => {
    const { row, cycle, self } = await review(tx, e, i.id);
    expected(row, i.expectedVersion);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${e.tenantId + ":decision:" + row.id},0))`;
    if (i.action === "FILE") {
      if (!self) fail("FORBIDDEN", "Only the employee may file an appeal", 403);
      if (
        !["RELEASED", "ACKNOWLEDGED"].includes(row.state) ||
        !row.appealDeadline ||
        localDate(e.now, cycle.timezone) > row.appealDeadline
      )
        fail("APPEAL_WINDOW_CLOSED", "Appeal window is not open", 409);
      if (
        await tx.perfAppeal.findFirst({
          where: { tenantId: e.tenantId, reviewId: row.id, status: "OPEN" },
        })
      )
        fail("STATE_CONFLICT", "An appeal is already open", 409);
      await tx.perfAppeal.create({
        data: {
          tenantId: e.tenantId,
          reviewId: row.id,
          revisionId: row.currentRevisionId,
          filedBy: e.who.id,
          reason: i.reason,
          decideBy: addWorkingDays(
            e.now,
            cycle.policy.appealDecisionDays,
            cycle.policy,
            cycle.timezone,
          ),
        },
      });
    } else {
      permit(e, "hr.performance.appeal.decide");
      const signs = await tx.perfSignoff.findMany({
        where: { tenantId: e.tenantId, reviewId: row.id },
      });
      independent(
        e,
        row,
        signs.map((s) => s.actorId),
      );
      const open = await tx.perfAppeal.findFirst({
        where: { tenantId: e.tenantId, reviewId: row.id, status: "OPEN" },
      });
      if (!open) fail("NOT_FOUND", "Open appeal not found", 404);
      await tx.perfAppeal.update({
        where: { id: open.id },
        data: {
          status: i.action,
          decidedAt: e.now,
          decidedBy: e.who.id,
          decisionReason: i.reason,
        },
      });
    }
    await sign(tx, e, row, "APPEAL_" + i.action, i);
    const next = await updateReview(
      tx,
      e,
      row,
      i.action === "REVISE" ? { state: "CORRECTION_OPEN" } : {},
    );
    await audit(tx, e, "APPEAL_" + i.action, row.id, next.version, i);
    return { id: row.id, version: next.version, state: next.state };
  });
};

async function cancelReminderSchedule(tx, e, row) {
  await tx.perfReminderIntent.updateMany({
    where: { tenantId: e.tenantId, reviewId: row.id, state: "PENDING" },
    data: { state: "CANCELLED" },
  });
}
