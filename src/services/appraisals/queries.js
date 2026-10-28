import { cycleMetrics, cycleMetricsCsv } from "./metrics.js";
import { createHash } from "node:crypto";
import * as C from "@trusoft/contracts/performance-appraisals";
import { run, has, permit, review, fail, audit } from "./base.js";

export const workspace = (raw) =>
  run(
    "workspace",
    raw,
    "hr.performance.read",
    async (tx, e) => {
      const hr = has(e, "hr.performance.read.all");
      const employees = await tx.employee.findMany({
        where: {
          tenant_id: e.tenantId,
          ...(!hr ? { OR: [{ id: e.who.id }, { managerId: e.who.id }] } : {}),
        },
        select: {
          id: true,
          employee_code: true,
          employee_name: true,
          first_name: true,
          last_name: true,
          managerId: true,
        },
        orderBy: { id: "asc" },
        take: 1000,
      });
      return {
        employeeId: e.who.id,
        permissions: e.ctx.permissions,
        administrator: e.ctx.user.isAdmin === true,
        coreEnabled: !!e.config?.coreEnabled,
        employees: employees.map((p) => ({
          id: p.id,
          code: p.employee_code,
          name:
            p.employee_name ||
            [p.first_name, p.last_name].filter(Boolean).join(" "),
          managerId: p.managerId,
        })),
        ...(has(e, "hr.performance.configure")
          ? { configuration: e.config }
          : {}),
      };
    },
    { read: true, configuration: true },
  );

export const analytics = (raw) => {
  const i = C.APPRAISAL_TOOLS.hr_appraisal_analytics[1].parse(raw);
  return run(
    "analytics",
    i,
    "hr.performance.audit",
    async (tx, e) => {
      permit(e, "hr.performance.read.all");
      const cycle = await tx.perfCycle.findFirst({
        where: { tenantId: e.tenantId, id: i.cycleId },
      });
      if (!cycle) fail("NOT_FOUND", "Cycle not found", 404);
      return {
        ...(await cycleMetrics(tx, e.tenantId, cycle.id, e.now)),
        closingSnapshot: cycle.closingSnapshot,
        restatedAfterClosure: !!cycle.closingSnapshot,
      };
    },
    { read: true },
  );
};

export const analyticsExport = (raw) => {
  const i = C.APPRAISAL_TOOLS.hr_appraisal_analytics_export[1].parse(raw);
  return run(
    "analytics.export",
    i,
    "hr.performance.audit",
    async (tx, e) => {
      const cycle = await tx.perfCycle.findFirst({
        where: { tenantId: e.tenantId, id: i.cycleId },
      });
      if (!cycle) fail("NOT_FOUND", "Cycle not found", 404);
      const report = {
        ...(await cycleMetrics(tx, e.tenantId, cycle.id, e.now)),
        closingSnapshot: cycle.closingSnapshot,
      };
      const content = cycleMetricsCsv(report);
      const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
      await audit(tx, e, "ANALYTICS_EXPORT", cycle.id, cycle.version, i, {
        format: "CSV",
        metricVersion: report.metricVersion,
        contentDigest: sha256,
        population: report.population,
      });
      return {
        filename: `appraisal-health-${cycle.id}.csv`,
        mediaType: "text/csv;charset=utf-8",
        content,
        digest: sha256,
        asOf: report.asOf,
      };
    },
    { authorize: (_tx, e) => permit(e, "hr.performance.read.all") },
  );
};

export const list = (raw) => {
  const i = C.ListQuery.parse(raw);
  return run(
    "list",
    i,
    "hr.performance.read",
    async (tx, e) => {
      const reports = await tx.employee.findMany({
        where: { tenant_id: e.tenantId, managerId: e.who.id },
        select: { id: true },
      });
      const reportIds = reports.map((p) => p.id);
      const hr = has(e, "hr.performance.read.all");
      const where = {
        tenantId: e.tenantId,
        ...(i.cursor ? { id: { gt: i.cursor } } : {}),
      };
      let model;
      if (i.kind === "reviews") {
        model = "perfReview";
        if (i.cycleId) where.cycleId = i.cycleId;
        if (!hr)
          where.OR = [
            { employeeId: e.who.id },
            { employeeId: { in: reportIds }, managerId: e.who.id },
          ];
      } else if (i.kind === "templates") {
        model = "perfTemplateVersion";
        permit(e, "hr.performance.configure");
      } else if (i.kind === "cycles") {
        model = "perfCycle";
        if (!hr) {
          const participants = await tx.perfReview.findMany({
            where: {
              tenantId: e.tenantId,
              OR: [
                { employeeId: e.who.id },
                { employeeId: { in: reportIds }, managerId: e.who.id },
              ],
            },
            select: { cycleId: true },
          });
          where.AND = [
            { id: { in: [...new Set(participants.map((p) => p.cycleId))] } },
          ];
        }
      } else if (i.kind === "goals") {
        model = "perfGoal";
        if (i.cycleId) where.cycleId = i.cycleId;
        if (!hr) where.employeeId = { in: [e.who.id, ...reportIds] };
      } else if (i.kind === "checkins") {
        model = "perfCheckin";
        if (!hr)
          where.OR = [
            { employeeId: e.who.id },
            { employeeId: { in: reportIds }, managerId: e.who.id },
          ];
      } else if (i.kind === "feedback") {
        model = "perfFeedback";
        where.OR = [
          { authorId: e.who.id },
          { employeeId: e.who.id, audience: "EMPLOYEE" },
          { employeeId: { in: reportIds }, audience: "MANAGER" },
          ...(has(e, "hr.performance.feedback.hr") ? [{ audience: "HR" }] : []),
        ];
      } else if (i.kind === "decisions") {
        model = "perfDecisionCase";
        permit(e, "hr.performance.decision.read");
        if (!hr) where.employeeId = { in: reportIds };
        if (!has(e, "hr.performance.compensation.read"))
          where.kind = { not: "COMPENSATION" };
      } else if (i.kind === "appeals") {
        model = "perfAppeal";
        if (!has(e, "hr.performance.appeal.decide")) where.filedBy = e.who.id;
      } else {
        model = "perfAudit";
        permit(e, "hr.performance.audit");
        // Participation receipts stay in the restricted journal; ordinary HR browsing
        // must not reveal which named nominees submitted confidential peer responses.
        where.operation = { not: "PEER_SUBMIT" };
      }
      const rows = await tx[model].findMany({
        where,
        orderBy: { id: "asc" },
        take: i.limit + 1,
      });
      const items = rows.slice(0, i.limit);
      if (i.kind === "cycles") {
        const runs = await tx.perfLaunchRun.findMany({
          where: {
            tenantId: e.tenantId,
            cycleId: { in: items.map((c) => c.id) },
          },
        });
        for (const cycle of items)
          cycle.launch = runs.find((r) => r.cycleId === cycle.id) ?? null;
      }
      return {
        items,
        nextCursor: rows.length > i.limit ? items.at(-1).id : null,
        asOf: e.now.toISOString(),
      };
    },
    { read: true },
  );
};
export const get = (raw) => {
  const i = C.GetQuery.parse(raw);
  return run(
    "get",
    i,
    "hr.performance.read",
    async (tx, e) => {
      const { row, cycle, self, manager, hr, employee } = await review(
        tx,
        e,
        i.id,
      );
      const released = !!row.releasedRevisionId;
      const template = await tx.perfTemplateVersion.findFirst({
        where: { id: cycle.templateId, tenantId: e.tenantId },
      });
      let responses = await tx.perfResponse.findMany({
        where: {
          tenantId: e.tenantId,
          reviewId: row.id,
          ...(self
            ? { role: "SELF" }
            : manager
              ? {
                  OR: [
                    { role: "MANAGER", authorId: e.who.id },
                    { role: "SELF", submittedAt: { not: null } },
                  ],
                }
              : {}),
        },
        orderBy: [{ role: "asc" }, { responseNo: "desc" }],
      });
      const visibleRevisionId = self
        ? row.releasedRevisionId
        : row.currentRevisionId;
      const revision = visibleRevisionId
        ? await tx.perfReviewRevision.findFirst({
            where: { id: visibleRevisionId, tenantId: e.tenantId },
          })
        : null;
      if (self && released && revision)
        responses = [
          ["SELF", revision.content.selfResponse],
          ["MANAGER", revision.content.managerResponse],
        ]
          .filter(([, a]) => a)
          .map(([role, answers]) => ({
            id: revision.id + "-" + role,
            role,
            answers,
            submittedAt: revision.createdAt,
          }));
      const evidence = await tx.perfEvidenceLink.findMany({
        where: {
          tenantId: e.tenantId,
          reviewId: row.id,
          ...(self && !released ? { verifiedBy: e.who.id } : {}),
        },
        orderBy: { createdAt: "asc" },
      });
      const assessments = await tx.assessmentAssignment.findMany({
        where: {
          tenantId: e.tenantId,
          employeeCode: employee.employee_code,
          state: "PUBLISHED",
        },
        select: { id: true },
        take: 50,
      });
      const candidateEvidence = await tx.assessmentRevision.findMany({
        where: {
          tenantId: e.tenantId,
          assessmentRef: { in: assessments.map((a) => a.id) },
          publishedAt: { not: null },
        },
        select: { id: true, revisionNo: true, publishedAt: true },
        orderBy: { publishedAt: "desc" },
        take: 50,
      });
      const appeals = await tx.perfAppeal.findMany({
        where: { tenantId: e.tenantId, reviewId: row.id },
        orderBy: { createdAt: "desc" },
      });
      const history = await tx.perfAudit.findMany({
        where: { tenantId: e.tenantId, aggregateId: row.id },
        select: { id: true, operation: true, version: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const actions = [];
      if (self && row.state === "SELF_OPEN") actions.push("SUBMIT_SELF");
      if (
        manager &&
        ["SELF_SUBMITTED", "SELF_OPEN", "CORRECTION_OPEN"].includes(row.state)
      )
        actions.push("SUBMIT_MANAGER");
      if (hr && !self && !manager) {
        for (const [action, permission, states] of [
          ["WAIVE_SELF", "cycle.manage", ["SELF_OPEN"]],
          ["APPROVE_SENIOR", "approve", ["APPROVAL_PENDING"]],
          [
            "RETURN",
            "approve",
            ["APPROVAL_PENDING", "CALIBRATION_READY", "CALIBRATION_PENDING"],
          ],
          ["PROPOSE_CALIBRATION", "calibrate", ["CALIBRATION_READY"]],
          ["APPROVE_CALIBRATION", "calibrate.approve", ["CALIBRATION_PENDING"]],
          ["CONFIRM_CALIBRATION", "calibrate.approve", ["CALIBRATION_READY"]],
          ["RELEASE", "release", ["CALIBRATED"]],
        ])
          if (
            has(e, "hr.performance." + permission) &&
            states.includes(row.state)
          )
            actions.push(action);
      }
      if (self && row.state === "RELEASED") actions.push("ACKNOWLEDGE");
      return {
        review: self
          ? {
              ...row,
              currentRevisionId: row.releasedRevisionId,
              revisionNo: revision?.revisionNo || 0,
              selfWaiver: null,
            }
          : row,
        cycle: {
          id: cycle.id,
          name: cycle.name,
          timezone: cycle.timezone,
          status: cycle.status,
        },
        employee: {
          id: employee.id,
          name:
            employee.employee_name ||
            [employee.first_name, employee.last_name].filter(Boolean).join(" "),
          code: employee.employee_code,
        },
        template,
        responses,
        revision,
        evidence:
          self && released ? revision?.content.evidence || [] : evidence,
        candidateEvidence: candidateEvidence.map((a) => ({
          sourceId: a.id,
          sourceVersion: String(a.revisionNo),
          label: `Assessment revision ${a.revisionNo} published ${a.publishedAt.toISOString().slice(0, 10)}`,
        })),
        appeals,
        history,
        role: self ? "SELF" : manager ? "MANAGER" : "HR",
        actions,
      };
    },
    { read: true },
  );
};
