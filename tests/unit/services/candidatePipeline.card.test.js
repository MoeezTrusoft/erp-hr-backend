// Pipeline card shape: the board addresses applications (D-05), so a card
// carries the application, candidate and requisition ids it acts on, plus the
// drawer's contact line.
import { jest } from "@jest/globals";

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: {} }));
jest.unstable_mockModule("../../../src/services/rbac.client.js", () => ({
  listDepartments: async () => [],
}));

const { toCard } = await import("../../../src/services/candidatePipeline.service.js");

describe("candidate pipeline card", () => {
  it("carries the ids a move, an interview and an offer address", () => {
    const card = toCard(
      {
        id: 901,
        candidateId: 77,
        jobRequisitionId: 9,
        stage: "applied",
        status: "applied",
        appliedAt: "2026-06-10T00:00:00.000Z",
        candidate: {
          firstName: "Zoe",
          lastName: "Khan",
          email: "zoe@example.com",
          phone: "+92 300 0000000",
          source: "Referral",
          parsedResume: { yearsOfExperience: "4" },
        },
        jobRequisition: { title: "Sales Lead", departmentId: 3 },
      },
      new Map([[3, "Sales"]])
    );
    expect(card).toMatchObject({
      applicationId: 901,
      candidateId: 77,
      jobRequisitionId: 9,
      name: "Zoe Khan",
      email: "zoe@example.com",
      phone: "+92 300 0000000",
      source: "Referral",
      position: "Sales Lead",
      department: "Sales",
      yearsExperience: 4,
    });
  });

  it("answers null for absent contact fields", () => {
    const card = toCard({ id: 1, candidateId: 2, candidate: { firstName: "A", email: "a@x.io" } });
    expect(card).toMatchObject({ jobRequisitionId: null, phone: null, source: null });
  });
});
