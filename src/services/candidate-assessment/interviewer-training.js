import { run, fail } from "./base.js";
function hr(env) {
  if (
    !env.ctx.user.roles?.some((r) =>
      ["HR_ADMIN", "HR_HEAD", "HR_MANAGER"].includes(String(r).toUpperCase()),
    )
  )
    fail("HR administration required", 403);
}
export const trainingList = (input = {}) =>
  run(
    "hr.recruitment.assessment.admin",
    async (tx, env) => {
      hr(env);
      const limit = Math.min(100, Math.max(1, input.limit ?? 30));
      const found = await tx.employee.findMany({
        where: {
          tenant_id: env.tenantId,
          ...(input.cursor ? { id: { gt: input.cursor } } : {}),
          ...(input.q
            ? {
                OR: [
                  { first_name: { contains: input.q, mode: "insensitive" } },
                  { last_name: { contains: input.q, mode: "insensitive" } },
                  { employee_code: { contains: input.q, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          employee_code: true,
          interviewerTrainedAt: true,
        },
        orderBy: { id: "asc" },
        take: limit + 1,
      });
      const items = found
        .slice(0, limit)
        .map((r) => ({
          employeeId: r.id,
          name: [r.first_name, r.last_name].filter(Boolean).join(" "),
          employeeCode: r.employee_code,
          trainedAt: r.interviewerTrainedAt,
        }));
      return {
        items,
        nextCursor: found.length > limit ? items.at(-1).employeeId : null,
        actorEmployeeId: env.who.id,
      };
    },
    "evaluationForms",
  );
export const trainingSet = (input) =>
  run(
    "hr.recruitment.assessment.admin",
    async (tx, env) => {
      hr(env);
      if (input.employeeId === env.who.id)
        fail("Another HR administrator must verify your training", 403);
      const employee = await tx.employee.findFirst({
        where: { tenant_id: env.tenantId, id: input.employeeId },
        select: { id: true },
      });
      if (!employee) fail("Employee not found", 404);
      const reason = String(input.reason ?? "").trim();
      if (reason.length < 10 || reason.length > 2000)
        fail("Provide the training evidence or revocation reason");
      const trainedAt = input.trainedAt ? new Date(input.trainedAt) : null;
      if (
        trainedAt &&
        (!Number.isFinite(trainedAt.getTime()) || trainedAt > env.now)
      )
        fail("Training completion must be a valid past date");
      await tx.employee.update({
        where: { id: employee.id },
        data: { interviewerTrainedAt: trainedAt },
      });
      await tx.log.create({
        data: {
          tenantId: env.tenantId,
          employeeId: employee.id,
          actionById: env.who.id,
          type: "UPDATE",
          action_type: "UPDATE",
          module: "Interviewer training",
          result: "SUCCESS",
          ip: env.ctx.ip ?? "unknown",
          os: "server",
          notes: JSON.stringify({ trainedAt, reason }),
          correlationId: env.ctx.correlationId ?? null,
        },
      });
      return { employeeId: employee.id, trainedAt };
    },
    "evaluationForms",
  );
