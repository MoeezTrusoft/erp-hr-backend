import test from "node:test";
import assert from "node:assert/strict";
import { EvaluationForm } from "@trusoft/contracts/recruitment-assessment";
import { roleSkillForm } from "../../src/services/candidate-assessment/role-skills.js";
const tenant = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002";
const base = () =>
  EvaluationForm.parse({
    sections: [
      {
        key: "base",
        title: "Base",
        criteria: [
          {
            key: "evidence",
            label: "Evidence",
            description: "Explains source checks",
            competencyKey: "evidence",
            weight: 1,
            anchors: {
              1: "No evidence",
              2: "Needs help",
              3: "Independent",
              4: "Strong",
              5: "Consistent",
            },
          },
        ],
      },
    ],
  });
const skills = [
  { id: 1, name: "JavaScript", tenantId: null },
  { id: 2, name: "SQL", tenantId: tenant },
  { id: 3, name: "Other company skill", tenantId: other },
];
const aliases = [
  {
    alias: "JS",
    skillId: 1,
    tenantId: null,
    scope: "PLATFORM",
    status: "ACTIVE",
  },
];
const req = (skills) => ({
  id: 100,
  tenantId: tenant,
  version: 4,
  jobContent: { skills },
});
test("canonical aliases deduplicate required and preferred skills and keep the published base unchanged", () => {
  const input = base(),
    before = JSON.stringify(input);
  const form = roleSkillForm(
    input,
    req([
      { name: "JS", importance: "required" },
      { name: "JavaScript", importance: "preferred" },
      { name: "SQL", importance: "preferred" },
    ]),
    [{ panelRole: "HR" }, { panelRole: "TECHNICAL" }],
    skills,
    aliases,
  );
  const section = form.sections.at(-1);
  assert.equal(section.criteria.length, 2);
  assert.deepEqual(section.panelRoles, ["TECHNICAL"]);
  assert.equal(section.criteria[0].required, true);
  assert.equal(section.criteria[0].weight, 2);
  assert.equal(section.criteria[1].required, false);
  assert.equal(section.criteria[1].mustHaveThreshold, null);
  assert.equal(Object.keys(section.criteria[0].anchors).length, 5);
  assert.equal(form.generation.requisitionVersion, 4);
  assert.equal(JSON.stringify(input), before);
});
test("unmapped and foreign skills stay visible as mapping gaps and are never guessed", () => {
  const form = roleSkillForm(
    base(),
    req(["Javascrip", "Other company skill"]),
    [],
    skills,
    aliases,
  );
  assert.equal(form.sections.length, 1);
  assert.deepEqual(form.generation.unmappedSkills, [
    "Javascrip",
    "Other company skill",
  ]);
});
test("approved blueprint competency coverage prevents duplicate criteria", () => {
  const form = roleSkillForm(base(), req(["JavaScript"]), [], skills, aliases, [
    { skillId: 1, competencyKey: "evidence" },
  ]);
  assert.equal(form.sections.length, 1);
});
test("legacy prose is not treated as an approved skill list and oversized generation fails instead of truncating", () => {
  const input = base();
  assert.equal(
    roleSkillForm(
      input,
      { id: 1, tenantId: tenant, requirements: "Unstructured legacy prose" },
      [],
      skills,
      aliases,
    ),
    input,
  );
  const many = Array.from({ length: 31 }, (_, i) => ({
    id: 100 + i,
    name: "Skill " + i,
    tenantId: tenant,
  }));
  assert.throws(
    () => roleSkillForm(base(), req(many.map((s) => s.name)), [], many, []),
    /size limit/,
  );
});
