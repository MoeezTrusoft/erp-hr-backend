import { json } from "./base.js";
const tokens = (value) =>
  new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((v) => v.length > 2),
  );
export async function taskImpact(tx, env, draft) {
  const d = draft.definition;
  const versions = await tx.assessmentTaskVersion.findMany({
    where: {
      tenantId: env.tenantId,
      familyCode: d.familyCode,
      status: "PUBLISHED",
    },
    select: { id: true, taskCode: true, taskVersion: true, definition: true },
    take: 2000,
  });
  const prior = versions
    .filter((t) => t.taskCode === d.taskCode && t.taskVersion < d.taskVersion)
    .sort((a, b) => b.taskVersion - a.taskVersion)[0];
  const words = tokens(`${d.title} ${d.outcome}`);
  const duplicateCandidates = versions
    .filter((t) => t.taskCode !== d.taskCode)
    .map((t) => {
      const other = tokens(`${t.definition.title} ${t.definition.outcome}`),
        intersection = [...words].filter((w) => other.has(w)).length;
      return {
        taskCode: t.taskCode,
        taskVersion: t.taskVersion,
        title: t.definition.title,
        similarity: intersection / new Set([...words, ...other]).size,
      };
    })
    .filter((t) => t.similarity >= 0.65)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10);
  const affected = await tx.assessmentProfileTask.findMany({
    where: { tenantId: env.tenantId, taskCode: d.taskCode },
    select: { profileRef: true },
  });
  const memberships = await tx.employeeAssessmentProfile.findMany({
    where: {
      tenantId: env.tenantId,
      profileRef: { in: affected.map((p) => p.profileRef) },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: env.now } }],
    },
    select: { employeeCode: true, profileRef: true },
  });
  const changedFields = prior
    ? Object.keys(d).filter(
        (k) => JSON.stringify(d[k]) !== JSON.stringify(prior.definition[k]),
      )
    : [];
  const payload = json({
    priorVersion: prior?.taskVersion || null,
    changedFields,
    prior: prior?.definition || null,
    proposed: d,
    affectedProfileRefs: [...new Set(affected.map((p) => p.profileRef))],
    affectedEmployeeCodes: [...new Set(memberships.map((m) => m.employeeCode))],
    duplicateCandidates,
    prospectiveOnly: true,
    requiresExplicitEquivalence: !!prior,
  });
  await tx.assessmentIntegration.upsert({
    where: {
      tenantId_kind_key: {
        tenantId: env.tenantId,
        kind: "CATALOG_IMPACT",
        key: draft.id,
      },
    },
    create: {
      tenantId: env.tenantId,
      employeeCode: env.who.employeeCode,
      kind: "CATALOG_IMPACT",
      key: draft.id,
      sourceRef: draft.id,
      status: "REVIEW_REQUIRED",
      payload,
    },
    update: { payload, sequence: { increment: 1 } },
  });
  return payload;
}
