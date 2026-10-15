import { SeparationQuery } from "@trusoft/contracts/employment";
import {
  run,
  fail,
  result,
  view,
  isHr,
  has,
  permit,
  taskModels,
  authorizedSeparation,
  employee,
  includesActor,
  ownsCode,
  employeeCodes,
} from "./base.js";
const mayReview = (s, env) =>
  isHr(env) ||
  (has(env, "hr.separation.approve") &&
    s.policySnapshot.authority.some(
      (a) =>
        a.category === s.category &&
        a.gradeCode === s.gradeCode &&
        includesActor(env, a.approverCodes),
    ));
export function separationView(s, env) {
  const payload = {
    createdByCode: s.createdByCode,
    isInitiator: ownsCode(env, s.createdByCode),
    type: s.type,
    reasonCode: s.reasonCode,
    proposedLastWorkingAt: s.proposedLastWorkingAt,
    lastWorkingAt: s.lastWorkingAt,
    submittedAt: s.submittedAt,
    approvedAt: s.approvedAt,
    deferredUntil: s.deferredUntil,
    withdrawalRequestedAt: s.withdrawalRequestedAt,
    managerCode: s.managerCode,
    category: s.category,
    gradeCode: s.gradeCode,
    rehireEligible: s.rehireEligible,
  };
  const full =
    isHr(env) ||
    ownsCode(env, s.employeeCode) ||
    s.managerCode === env.who.employee_code ||
    mayReview(s, env);
  if (full) {
    payload.reason = s.reason;
    payload.recommendation = s.recommendation;
    payload.documents = s.documents;
  }
  if (mayReview(s, env)) payload.verification = s.verification;
  return view(s, "SEPARATION", payload);
}
export const listSeparations = (raw) => {
  const input = SeparationQuery.parse(raw);
  return run(
    input,
    null,
    async (tx, env) => {
      if (input.separationRef) {
        if (!input.employeeCode)
          fail("Employee code is required with a separation reference");
        const s = await authorizedSeparation(tx, env, input),
          items = [];
        const subject = await employee(tx, env.tenantId, s.employeeCode);
        if (subject.managerId === env.who.id)
          s.managerCode = env.who.employee_code;
        for (const [kind, model] of Object.entries(taskModels)) {
          if (kind === "INTERVIEW" && !isHr(env)) continue;
          if (
            kind === "SETTLEMENT" &&
            !isHr(env) &&
            !has(env, "hr.separation.settle")
          )
            continue;
          const rows = await tx[model].findMany({
            where: { tenantId: env.tenantId, separationRef: s.id },
            orderBy: { createdAt: "asc" },
          });
          for (const row of rows) {
            if (
              !isHr(env) &&
              !ownsCode(env, s.employeeCode) &&
              s.managerCode !== env.who.employee_code &&
              !has(env, "hr.separation.approve") &&
              !has(env, "hr.separation.settle") &&
              !ownsCode(env, row.ownerCode) &&
              !(
                kind === "CLEARANCE" &&
                s.policySnapshot.clearanceDepartments.some(
                  (d) =>
                    d.departmentCode === row.key &&
                    includesActor(env, d.signerCodes),
                )
              )
            )
              continue;
            items.push(
              view(row, kind, {
                ...row.payload,
                evidenceRefs: row.evidenceRefs,
              }),
            );
          }
        }
        if (isHr(env) || has(env, "hr.separation.settle"))
          for (const row of await tx.separationSourceSnapshot.findMany({
            where: { tenantId: env.tenantId, separationRef: s.id },
          }))
            items.push(view(row, "SOURCE", row.payload));
        for (const row of await tx.separationTransition.findMany({
          where: { tenantId: env.tenantId, separationRef: s.id },
          orderBy: { createdAt: "asc" },
        }))
          items.push(
            view(row, "HISTORY", {
              ...row.payload,
              ...(row.payload.review && !mayReview(s, env)
                ? {
                    review: {
                      recommendation: row.payload.review.recommendation,
                    },
                  }
                : {}),
              actorCode: row.actorCode,
            }),
          );
        const e = await employee(tx, env.tenantId, s.employeeCode);
        if (s.submittedAt) {
          const rows = await tx.attendance.findMany({
            where: {
              tenantId: env.tenantId,
              employeeId: e.id,
              date: { gte: s.submittedAt, lte: s.lastWorkingAt || env.now },
            },
            select: { date: true, status: true },
            take: 730,
            orderBy: { date: "desc" },
          });
          items.push(
            view(s, "NOTICE_ATTENDANCE", {
              daysRemaining: s.lastWorkingAt
                ? Math.max(0, Math.ceil((s.lastWorkingAt - env.now) / 86400000))
                : null,
              days: rows,
            }),
          );
        }
        return result(env, separationView(s, env), items);
      }
      const where = {
        tenantId: env.tenantId,
        ...(input.state ? { state: input.state } : {}),
        ...(input.employeeCode
          ? { employeeCode: { in: employeeCodes(env, input.employeeCode) } }
          : {}),
      };
      if (input.view === "SELF") {
        permit(env, "hr.separation.self");
        if (input.employeeCode && !ownsCode(env, input.employeeCode))
          fail("Separation not found", 404);
        where.employeeCode = { in: env.identityCodes };
      } else if (input.view === "MANAGER") {
        permit(env, "hr.separation.manager");
        const reports = await tx.employee.findMany({
          where: { tenant_id: env.tenantId, managerId: env.who.id },
          select: { employee_code: true },
        });
        const codes = reports.flatMap((r) =>
          employeeCodes(env, r.employee_code),
        );
        where.employeeCode = {
          in: input.employeeCode
            ? employeeCodes(env, input.employeeCode).filter((code) =>
                codes.includes(code),
              )
            : codes,
        };
      } else if (input.view === "APPROVER") {
        permit(env, "hr.separation.approve");
        const candidates = await tx.separation.findMany({
          where,
          select: {
            id: true,
            category: true,
            gradeCode: true,
            policySnapshot: true,
          },
        });
        where.id = {
          in: candidates
            .filter((s) =>
              s.policySnapshot.authority.some(
                (a) =>
                  a.category === s.category &&
                  a.gradeCode === s.gradeCode &&
                  includesActor(env, a.approverCodes),
              ),
            )
            .map((s) => s.id),
        };
      } else if (input.view === "HR") permit(env, "hr.separation.read");
      else {
        if (!has(env, "hr.separation.task")) permit(env, "hr.separation.clear");
        const refs = new Set();
        for (const model of [
          "replacementPlan",
          "replacementSession",
          "knowledgeTransferItem",
          "assetHandoverItem",
          "accessRevocationTask",
          "clearanceItem",
        ])
          for (const t of await tx[model].findMany({
            where: {
              tenantId: env.tenantId,
              ownerCode: { in: env.identityCodes },
            },
            select: { separationRef: true },
          }))
            refs.add(t.separationRef);
        const candidates = await tx.separation.findMany({
          where: {
            tenantId: env.tenantId,
            state: { notIn: ["EXIT_COMPLETED", "CANCELLED", "WITHDRAWN"] },
          },
          select: { id: true, policySnapshot: true },
        });
        for (const s of candidates)
          if (
            s.policySnapshot.clearanceDepartments.some((d) =>
              includesActor(env, d.signerCodes),
            )
          )
            refs.add(s.id);
        where.id = { in: [...refs] };
      }
      const rows = await tx.separation.findMany({
          where,
          orderBy: { id: "asc" },
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        }),
        more = rows.length > input.limit,
        selected = rows.slice(0, input.limit),
        items = [];
      for (const s of selected) {
        const row = separationView(s, env);
        row.payload.overdueTasks = 0;
        row.payload.openClearances = await tx.clearanceItem.count({
          where: {
            tenantId: env.tenantId,
            separationRef: s.id,
            status: { not: "COMPLETED" },
          },
        });
        for (const model of [
          "replacementSession",
          "knowledgeTransferItem",
          "assetHandoverItem",
          "accessRevocationTask",
          "clearanceItem",
        ])
          row.payload.overdueTasks += await tx[model].count({
            where: {
              tenantId: env.tenantId,
              separationRef: s.id,
              dueAt: { lt: env.now },
              status: { not: "COMPLETED" },
            },
          });
        items.push(row);
      }
      const p =
        input.view === "HR" && isHr(env)
          ? await tx.separationPolicy.findUnique({
              where: { tenantId: env.tenantId },
            })
          : null;
      return result(
        env,
        p ? view(p, "POLICY", p.policy) : null,
        items,
        more ? selected.at(-1).id : null,
      );
    },
    "LIST",
  );
};
