import { chooseRaters } from "@trusoft/contracts/assessment-rules";
import { qualifiedCandidates } from "./workflow.js";
import { identity, hash, json, days, exception } from "./base.js";
export async function offerHarvestedOpportunities(
  tx,
  env,
  cfg,
  profiles,
  trigger,
) {
  if (!trigger) return;
  const evidence = await tx.assessmentEvidence.findMany({
    where: {
      tenantId: env.tenantId,
      source: "PM",
      accepted: true,
      withdrawnAt: null,
      scanState: "CLEAN",
      captureAt: { gte: new Date(env.now - days(30)) },
    },
    orderBy: { captureAt: "desc" },
    take: 100,
  });
  for (const e of evidence) {
    const key = `harvest:${e.caseRef}`;
    if (
      await tx.assessmentIntegration.findUnique({
        where: {
          tenantId_kind_key: {
            tenantId: env.tenantId,
            kind: "OPPORTUNITY",
            key,
          },
        },
      })
    )
      continue;
    const membership = profiles.find((p) => p.employeeCode === e.employeeCode);
    if (!membership) continue;
    const profile = await tx.assessmentProfileVersion.findFirst({
      where: {
        tenantId: env.tenantId,
        id: membership.profileRef,
        status: "PUBLISHED",
      },
    });
    if (!profile) continue;
    const codes = e.taskCodes.filter((c) =>
      profile.definition.requirements.some((r) => r.taskCode === c),
    );
    if (!codes.length) continue;
    const tasks = await tx.assessmentTaskVersion.findMany({
      where: {
        tenantId: env.tenantId,
        OR: profile.definition.requirements
          .filter((r) => codes.includes(r.taskCode))
          .map((r) => ({ taskCode: r.taskCode, taskVersion: r.taskVersion })),
        status: "PUBLISHED",
      },
    });
    const families = [...new Set(tasks.map((t) => t.familyCode))];
    if (
      trigger.scopeFilter.familyCodes?.length &&
      !families.some((f) => trigger.scopeFilter.familyCodes.includes(f))
    )
      continue;
    let employee;
    try {
      employee = await identity(tx, env.tenantId, e.employeeCode);
    } catch (error) {
      if (!error.status) throw error;
      await exception(
        tx,
        env,
        `opportunity:${e.caseRef}`,
        "EMPLOYMENT_SCOPE_CHANGE",
        e.caseRef,
        { employeeCode: e.employeeCode, reason: error.code },
      );
      continue;
    }
    const candidates = (
      await qualifiedCandidates(tx, env, employee, families)
    ).filter((c) =>
      tasks.every((t) =>
        c.qualifications.some(
          (q) =>
            q.familyCode === t.familyCode &&
            (q.scopes.includes("*") || q.scopes.includes(t.definition.scope)),
        ),
      ),
    );
    const selection = chooseRaters({
      employee,
      candidates,
      familyCodes: families,
      now: env.now,
      maxOpen: cfg.policy.raterMaxOpen,
    });
    if (!selection.raterCode) {
      await exception(
        tx,
        env,
        `opportunity:${e.caseRef}`,
        "RATER_UNAVAILABLE",
        e.caseRef,
        { employeeCode: e.employeeCode },
      );
      continue;
    }
    const payload = {
      taskCodes: codes,
      caseRef: e.caseRef,
      evidenceRefs: [e.id],
      raterCode: selection.raterCode,
      dueAt: new Date(
        env.now.getTime() + days(trigger.policy.dueDays),
      ).toISOString(),
      reason:
        "Completed project work is available for a deliberate practical observation.",
    };
    const row = await tx.assessmentIntegration.create({
      data: {
        tenantId: env.tenantId,
        employeeCode: e.employeeCode,
        kind: "OPPORTUNITY",
        key,
        sourceRef: profile.id,
        status: "OFFERED",
        payload,
      },
    });
    await tx.assessmentNotification.create({
      data: {
        tenantId: env.tenantId,
        employeeCode: selection.raterCode,
        key: `opportunity:${row.id}`,
        kind: "OPPORTUNITY",
        dueAt: env.now,
        payload: { ref: row.id, employeeCode: e.employeeCode },
      },
    });
    await tx.assessmentAutomationRun.create({
      data: {
        tenantId: env.tenantId,
        runKey: `opportunity:${row.id}`,
        policyVersion: trigger.version,
        kind: "OPPORTUNISTIC",
        inputDigest: hash({ caseRef: e.caseRef, profileRef: profile.id }),
        inputs: json({ caseRef: e.caseRef, profileRef: profile.id }),
        actions: { offerRef: row.id, raterCode: selection.raterCode },
        outcome: "OFFERED",
      },
    });
  }
}
