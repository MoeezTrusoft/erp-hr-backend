// tests/unit/publicPortal.select-shape.test.js
//
// D-01 — the public job listing selected `department` (JobRequisition has no
// such relation) and `gradeLevel.bandMin/bandMax` (the fields are minSalary and
// maxSalary). Every portal suite mocks Prisma, so the invalid select could only
// fail against a real database. This test checks the select against the
// generated Prisma datamodel instead, recursively through relations.
import { describe, it, expect } from "@jest/globals";
import { Prisma } from "@prisma/client";
import { PUBLIC_JOB_SELECT } from "../../src/lib/public-portal.util.js";

const models = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, model]));

function invalidKeys(modelName, select, path = modelName) {
  const model = models.get(modelName);
  const problems = [];
  for (const [key, value] of Object.entries(select)) {
    const field = model.fields.find((candidate) => candidate.name === key);
    if (!field) {
      problems.push(`${path}.${key}`);
      continue;
    }
    if (value && typeof value === "object" && value.select) {
      expect(field.kind).toBe("object");
      problems.push(...invalidKeys(field.type, value.select, `${path}.${key}`));
    }
  }
  return problems;
}

describe("public job listing select", () => {
  it("names only fields and relations that exist on JobRequisition", () => {
    expect(invalidKeys("JobRequisition", PUBLIC_JOB_SELECT)).toEqual([]);
  });

  it("still never selects internal identifiers or approval state", () => {
    for (const key of ["requestedById", "approvedById", "departmentId", "approvals", "budgetedAmount", "approvalChainSnapshot"]) {
      expect(PUBLIC_JOB_SELECT).not.toHaveProperty(key);
    }
  });
});
