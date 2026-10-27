import { EvaluationForm } from "@trusoft/contracts/recruitment-assessment";
import { buildAliasIndex, resolveSkill } from "../../lib/skillNormalization.js";
import { requisitionSkillRequirements } from "../../lib/applicationFitScore.js";
import { fail } from "./rules.js";
export function roleSkillForm(
  definition,
  requisition,
  panels,
  skills,
  aliases,
  items = [],
) {
  const requirements = requisitionSkillRequirements(requisition.jobContent);
  if (!requirements.required.length && !requirements.preferred.length)
    return definition;
  const index = buildAliasIndex(aliases, skills, requisition.tenantId),
    byId = new Map(skills.map((skill) => [skill.id, skill]));
  const existing = definition.sections.flatMap((section) => section.criteria),
    covered = new Set();
  for (const criterion of existing) {
    const canonical =
      resolveSkill(index, criterion.competencyKey).skillId ??
      resolveSkill(index, criterion.label).skillId;
    if (canonical) covered.add(canonical);
    for (const item of items)
      if (item.competencyKey === criterion.competencyKey)
        covered.add(item.skillId);
  }
  const added = [],
    unmapped = [],
    used = new Set(covered),
    keys = new Set(existing.map((c) => c.key));
  for (const importance of ["required", "preferred"])
    for (const raw of requirements[importance]) {
      const name = typeof raw === "string" ? raw : raw?.name;
      const skillId = resolveSkill(index, name).skillId,
        skill = byId.get(skillId);
      if (
        !skill ||
        (skill.tenantId && skill.tenantId !== requisition.tenantId)
      ) {
        unmapped.push(String(name ?? ""));
        continue;
      }
      if (used.has(skillId)) continue;
      used.add(skillId);
      const key = "requisition_skill_" + skillId;
      if (keys.has(key))
        fail(
          "A form criterion conflicts with a generated requisition skill; revise the template",
        );
      added.push({
        key,
        label: skill.name,
        description:
          "Demonstrate " +
          skill.name +
          " using a relevant work example or the supplied role task.",
        competencyKey:
          items.find((item) => item.skillId === skillId)?.competencyKey ??
          "skill:" + skillId,
        weight: importance === "required" ? 2 : 1,
        required: importance === "required",
        scale: "FIVE",
        mustHaveThreshold: null,
        questionIds: [],
        anchors: {
          1: "Does not demonstrate the basic steps or supporting evidence.",
          2: "Demonstrates some steps but needs substantial guidance or correction.",
          3: "Completes a routine task independently and explains the checks used.",
          4: "Handles a complex example accurately and explains trade-offs with evidence.",
          5: "Handles complex cases consistently, verifies outcomes and explains how to improve the approach.",
        },
      });
    }
  const sections = [...definition.sections];
  if (added.length) {
    if (added.length > 30 || sections.length >= 10)
      fail(
        "The role skills exceed the form size limit; consolidate the approved template before scheduling",
      );
    const panel =
      panels.find((p) => String(p.panelRole).toUpperCase() === "TECHNICAL") ??
      panels.find(
        (p) => String(p.panelRole).toUpperCase() === "HIRING_MANAGER",
      ) ??
      panels.find((p) => p.panelRole);
    let key = "requisition_skills";
    while (sections.some((section) => section.key === key)) key += "_";
    sections.push({
      key,
      title: "Role-specific skills",
      panelRoles: panel ? [panel.panelRole] : [],
      criteria: added,
    });
  }
  return EvaluationForm.parse({
    ...definition,
    sections,
    generation: {
      method: "ROLE_SKILLS_V1",
      requisitionId: requisition.id,
      requisitionVersion: requisition.version ?? 0,
      unmappedSkills: [...new Set(unmapped)].filter(Boolean),
    },
  });
}
export async function addRoleSkills(
  tx,
  tenantId,
  definition,
  requisition,
  panels,
  blueprint,
) {
  const requirements = requisitionSkillRequirements(requisition.jobContent);
  if (!requirements.required.length && !requirements.preferred.length)
    return definition;
  const skills = await tx.skill.findMany({
    where: { OR: [{ tenantId: null }, { tenantId }] },
    select: { id: true, name: true, tenantId: true },
    orderBy: { id: "asc" },
  });
  const aliases = await tx.skillAlias.findMany({
    where: { OR: [{ tenantId: null }, { tenantId }], status: "ACTIVE" },
    select: {
      alias: true,
      skillId: true,
      scope: true,
      status: true,
      tenantId: true,
    },
    orderBy: { id: "asc" },
  });
  const items = blueprint
    ? await tx.candidateTestItem.findMany({
        where: {
          tenantId,
          status: "PUBLISHED",
          jobFamily: blueprint.jobFamily,
          competencyKey: {
            in: blueprint.sections.map((section) => section.competencyKey),
          },
        },
        select: { skillId: true, competencyKey: true },
        orderBy: { id: "asc" },
      })
    : [];
  return roleSkillForm(
    definition,
    { ...requisition, tenantId },
    panels,
    skills,
    aliases,
    items,
  );
}
