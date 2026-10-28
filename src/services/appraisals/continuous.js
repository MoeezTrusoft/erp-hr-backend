import * as C from "@trusoft/contracts/performance-appraisals";
import {
  assertAcyclic,
  keyResultProgress,
} from "@trusoft/contracts/performance-appraisal-rules";
import {
  run,
  fail,
  has,
  permit,
  person,
  expected,
  review,
  audit,
  updateReview,
  json,
} from "./base.js";

async function employeeScope(tx, e, id) {
  const employee = await person(tx, e.tenantId, id);
  const self = id === e.who.id,
    manager = employee.managerId === e.who.id && !self;
  if (!self && !manager && !has(e, "hr.performance.read.all"))
    fail("NOT_FOUND", "Employee not found", 404);
  return { employee, self, manager };
}
export const goalCreate = (raw) => {
  const i = C.GoalCreate.parse(raw);
  return run("goal.create", i, "hr.performance.goal.write", async (tx, e) => {
    await employeeScope(tx, e, i.employeeId);
    const cycle = await tx.perfCycle.findFirst({
      where: {
        id: i.cycleId,
        tenantId: e.tenantId,
        status: { in: ["DRAFT", "ACTIVE"] },
      },
    });
    if (!cycle) fail("NOT_FOUND", "Open cycle not found", 404);
    if (i.parentId) {
      const parent = await tx.perfGoal.findFirst({
        where: {
          id: i.parentId,
          tenantId: e.tenantId,
          cycleId: i.cycleId,
          status: "APPROVED",
        },
      });
      if (!parent) fail("NOT_FOUND", "Approved parent goal not found", 404);
    }
    const row = await tx.perfGoal.create({
      data: {
        tenantId: e.tenantId,
        cycleId: i.cycleId,
        employeeId: i.employeeId,
        title: i.title,
        parentId: i.parentId,
        keyResults: i.keyResults,
      },
    });
    await audit(tx, e, "GOAL_CREATE", row.id, 0, i);
    return { id: row.id, version: 0, status: "DRAFT" };
  });
};
export const goalAction = (raw) => {
  const i = C.GoalAction.parse(raw);
  return run("goal.action", i, "hr.performance.goal.write", async (tx, e) => {
    const row = await tx.perfGoal.findFirst({
      where: { id: i.id, tenantId: e.tenantId },
    });
    if (!row) fail("NOT_FOUND", "Goal not found", 404);
    expected(row, i.expectedVersion);
    const scope = await employeeScope(tx, e, row.employeeId);
    let data = {};
    if (i.action === "APPROVE") {
      permit(e, "hr.performance.goal.approve");
      if (
        scope.self ||
        (!scope.manager && !has(e, "hr.performance.cycle.manage"))
      )
        fail("FORBIDDEN", "Independent manager or HR approval required", 403);
      if (row.status !== "DRAFT")
        fail("STATE_CONFLICT", "Goal is not a draft", 409);
      data = { status: "APPROVED", approvedBy: e.who.id };
    } else {
      if (!i.parentId) fail("VALIDATION_FAILED", "Parent goal required");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${e.tenantId + ":goal-graph:" + row.cycleId},0))`;
      const parent = await tx.perfGoal.findFirst({
        where: {
          id: i.parentId,
          tenantId: e.tenantId,
          cycleId: row.cycleId,
          status: "APPROVED",
        },
      });
      if (!parent) fail("NOT_FOUND", "Approved parent goal not found", 404);
      const edges = await tx.perfGoal.findMany({
        where: { tenantId: e.tenantId, cycleId: row.cycleId },
        select: { id: true, parentId: true },
      });
      assertAcyclic(edges, row.id, i.parentId);
      data = { parentId: i.parentId, status: "DRAFT", approvedBy: null };
    }
    const changed = await tx.perfGoal.updateMany({
      where: { id: row.id, tenantId: e.tenantId, version: row.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (changed.count !== 1) fail("VERSION_CONFLICT", "Goal changed", 412);
    await audit(tx, e, "GOAL_" + i.action, row.id, row.version + 1, i, {
      previousParentId: row.parentId,
    });
    return { id: row.id, version: row.version + 1, status: data.status };
  });
};
export const measurement = (raw) => {
  const i = C.Measurement.parse(raw);
  return run("measurement", i, "hr.performance.goal.write", async (tx, e) => {
    const row = await tx.perfGoal.findFirst({
      where: { id: i.id, tenantId: e.tenantId },
    });
    if (!row) fail("NOT_FOUND", "Goal not found", 404);
    await employeeScope(tx, e, row.employeeId);
    expected(row, i.expectedVersion);
    if (row.status !== "APPROVED")
      fail("STATE_CONFLICT", "Only approved goals accept measurements", 409);
    const kr = row.keyResults.find((k) => k.id === i.keyResultId);
    if (!kr) fail("NOT_FOUND", "Key result not found", 404);
    if (i.sourceSystem !== "MANUAL")
      fail(
        "FORBIDDEN",
        "External source measurements require the authenticated source consumer",
        403,
      );
    const prior = await tx.perfMeasurement.findFirst({
      where: {
        tenantId: e.tenantId,
        goalId: row.id,
        keyResultId: kr.id,
        sourceSystem: i.sourceSystem,
        sourceRef: i.sourceRef,
        period: i.period,
      },
      orderBy: { sourceVersion: "desc" },
    });
    if (prior && prior.sourceVersion >= i.sourceVersion) {
      if (prior.sourceVersion === i.sourceVersion && prior.actual === i.actual)
        return { id: row.id, version: row.version, measurementId: prior.id };
      fail("SOURCE_VERSION_CONFLICT", "Measurement version must increase", 409);
    }
    const created = await tx.perfMeasurement.create({
      data: {
        tenantId: e.tenantId,
        goalId: row.id,
        keyResultId: kr.id,
        actual: i.actual,
        sourceSystem: i.sourceSystem,
        sourceRef: i.sourceRef,
        period: i.period,
        sourceVersion: i.sourceVersion,
        progress: keyResultProgress(kr, i.actual),
        recordedBy: e.who.id,
      },
    });
    await tx.perfGoal.update({
      where: { id: row.id },
      data: { version: { increment: 1 } },
    });
    await audit(tx, e, "MEASUREMENT", row.id, row.version + 1, i);
    return { id: row.id, version: row.version + 1, measurementId: created.id };
  });
};
export const checkinCreate = (raw) => {
  const i = C.CheckinCreate.parse(raw);
  return run(
    "checkin.create",
    i,
    "hr.performance.checkin.write",
    async (tx, e) => {
      const { employee } = await employeeScope(tx, e, i.employeeId);
      if (!employee.managerId || employee.managerId === employee.id)
        fail(
          "ASSIGNMENT_INVALID",
          "An independent current manager is required",
        );
      await person(tx, e.tenantId, employee.managerId);
      const row = await tx.perfCheckin.create({
        data: {
          tenantId: e.tenantId,
          employeeId: employee.id,
          managerId: employee.managerId,
          scheduledAt: new Date(i.scheduledAt),
          agenda: i.agenda,
          actions: i.actions,
        },
      });
      await audit(tx, e, "CHECKIN_CREATE", row.id, 0, i);
      return { id: row.id, version: 0 };
    },
  );
};
export const checkinConfirm = (raw) => {
  const i = C.CheckinConfirm.parse(raw);
  return run(
    "checkin.confirm",
    i,
    "hr.performance.checkin.write",
    async (tx, e) => {
      const row = await tx.perfCheckin.findFirst({
        where: { id: i.id, tenantId: e.tenantId },
      });
      if (!row) fail("NOT_FOUND", "Check-in not found", 404);
      const scope = await employeeScope(tx, e, row.employeeId);
      expected(row, i.expectedVersion);
      if (!scope.self && !(scope.manager && row.managerId === e.who.id))
        fail("FORBIDDEN", "Only the participants can confirm", 403);
      if (row.notes && row.notes !== i.notes)
        fail(
          "STATE_CONFLICT",
          "Both participants must confirm the same notes",
          409,
        );
      const field = scope.self ? "employeeConfirmedAt" : "managerConfirmedAt";
      if (row[field]) fail("STATE_CONFLICT", "Already confirmed", 409);
      await tx.perfCheckin.update({
        where: { id: row.id },
        data: { notes: i.notes, [field]: e.now, version: { increment: 1 } },
      });
      await audit(tx, e, "CHECKIN_CONFIRM", row.id, row.version + 1, i);
      return { id: row.id, version: row.version + 1 };
    },
  );
};
export const feedbackCreate = (raw) => {
  const i = C.FeedbackCreate.parse(raw);
  return run(
    "feedback.create",
    i,
    "hr.performance.feedback.write",
    async (tx, e) => {
      await person(tx, e.tenantId, i.employeeId);
      if (i.reviewId) {
        const r = await review(tx, e, i.reviewId);
        if (r.row.employeeId !== i.employeeId)
          fail("VALIDATION_FAILED", "Review subject does not match");
      }
      const row = await tx.perfFeedback.create({
        data: {
          tenantId: e.tenantId,
          employeeId: i.employeeId,
          authorId: e.who.id,
          reviewId: i.reviewId,
          audience: i.audience,
          text: i.text,
        },
      });
      await audit(tx, e, "FEEDBACK_CREATE", row.id, 0, i);
      return { id: row.id };
    },
  );
};
export const evidenceLink = (raw) => {
  const i = C.EvidenceLink.parse(raw);
  return run(
    "evidence.link",
    i,
    "hr.performance.response.write",
    async (tx, e) => {
      const { row, employee, self, manager } = await review(tx, e, i.id, {
        write: true,
        correction: true,
      });
      expected(row, i.expectedVersion);
      if (!self && !manager)
        fail("FORBIDDEN", "Only the response author may attach evidence", 403);
      if (
        !["SELF_OPEN", "SELF_SUBMITTED", "CORRECTION_OPEN"].includes(
          row.state,
        ) ||
        (self && row.state !== "SELF_OPEN")
      )
        fail("STATE_CONFLICT", "Evidence manifest is frozen", 409);
      let snapshot;
      if (i.source === "ASSESSMENT") {
        const revision = await tx.assessmentRevision.findFirst({
          where: { tenantId: e.tenantId, id: i.sourceId },
        });
        const assignment =
          revision &&
          (await tx.assessmentAssignment.findFirst({
            where: {
              tenantId: e.tenantId,
              id: revision.assessmentRef,
              employeeCode: employee.employee_code,
              state: "PUBLISHED",
            },
          }));
        if (
          !assignment ||
          String(revision.revisionNo) !== i.sourceVersion ||
          !revision.publishedAt
        )
          fail(
            "NOT_FOUND",
            "Published assessment revision not found for this employee",
            404,
          );
        snapshot = {
          assignmentId: assignment.id,
          revisionId: revision.id,
          revisionNo: revision.revisionNo,
          digest: revision.digest,
        };
      } else
        fail(
          "INTEGRATION_NOT_READY",
          "DAM evidence requires a verified version and audience adapter before enablement",
          409,
        );
      const link = await tx.perfEvidenceLink.create({
        data: {
          tenantId: e.tenantId,
          reviewId: row.id,
          source: i.source,
          sourceId: i.sourceId,
          sourceVersion: i.sourceVersion,
          description: i.description,
          verifiedBy: e.who.id,
          snapshot: json(snapshot),
        },
      });
      const next = await updateReview(tx, e, row, {});
      await audit(tx, e, "EVIDENCE_LINK", row.id, next.version, i);
      return { id: row.id, evidenceId: link.id, version: next.version };
    },
  );
};
