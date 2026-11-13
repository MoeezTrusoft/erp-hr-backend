import library from "./catalog-library.json" with { type: "json" };
import { TaskDefinition } from "@trusoft/contracts/assessment";
import { identity, fail, audit, json } from "./base.js";
export const catalogFamilies = [
  "Software Development",
  "Network Engineering and Support",
  "Network Operations and Maintenance",
  "IT Infrastructure and Security",
  "Project Delivery Management",
  "Digital Asset Management",
  "Communication and Coordination",
  "Personalization and Automation",
  "QA and Test Engineering",
  "Product Management and Business Analysis",
  "Data Analytics and BI",
  "Telecom Service Delivery and Provisioning",
  "CATV Headend and Broadcast",
  "Voice and Switching",
  "Research and Development",
  "Human Resources",
  "Finance and Accounting",
  "Sales",
  "Marketing and Campaigns",
  "Supply Chain",
  "Legal and Compliance",
  "Administration and Facilities",
  "Customer Care and Contact Centre",
  "Internal Audit and Risk",
  "Executive Office and Secretariat",
  "Content Writing and Editorial",
  "Editorial Content Lifecycle",
  "Visual Creatives",
  "Publishing and Distribution",
  "Ghostwriting and Author Services",
  "Book Production and Print",
  "Ecommerce and Marketplace",
  "Department and Executive Leadership",
  "Production Planning and Control",
  "Spinning Weaving and Knitting",
  "Dyeing Finishing and Chemical",
  "Cutting Sewing and Garment",
  "Quality Laboratory and Inspection",
  "Plant Maintenance and Utilities",
  "Product Development and Merchandising",
  "Export Documentation and Trade",
].map((label, index) => ({
  code: `FAMILY_${String(index + 1).padStart(2, "0")}`,
  label,
}));
export const libraryIndex = library.libraries.map((l) => ({
  namespace: l.namespace,
  sourceDocument: l.sourceDocument,
  sha256: l.sha256,
  taskCount: l.tasks.length,
}));
export async function importCatalogLibrary(tx, env, input) {
  await identity(tx, env.tenantId, input.ownerCode);
  const source = library.libraries.find((l) => l.namespace === input.namespace);
  if (!source) fail("CATALOG_LIBRARY", "Unknown source catalogue");
  const familyCode = {
    SW: "FAMILY_01",
    "NET-ENG": "FAMILY_02",
    "NET-OPS": "FAMILY_03",
  }[source.namespace];
  const created = [],
    skipped = [];
  const sections = [...new Set(source.tasks.map((t) => t.section))];
  for (const t of source.tasks) {
    if (
      await tx.assessmentTaskVersion.findFirst({
        where: { tenantId: env.tenantId, taskCode: t.taskCode, taskVersion: 1 },
      })
    ) {
      skipped.push(t.taskCode);
      continue;
    }
    const naReasons = Object.fromEntries(
      Object.entries(t.applicability)
        .filter(([, v]) => !v)
        .map(([d]) => [
          d,
          d === "V" ? "TIMING_NOT_MEANINGFUL" : "OUTSIDE_APPROVED_SCOPE",
        ]),
    );
    const definition = TaskDefinition.parse({
      taskCode: t.taskCode,
      taskVersion: 1,
      title: t.criterion.slice(0, 240),
      sectionCode: `${source.namespace}-S${sections.indexOf(t.section) + 1}`,
      familyCode,
      outcome: t.criterion,
      scope: t.scope || t.section,
      complexity: "OWNER_REVIEW_REQUIRED",
      technology: "OWNER_REVIEW_REQUIRED",
      critical: t.critical,
      applicability: t.applicability,
      naReasons,
      evidencePolicy: {
        methods: [
          "OBSERVED_WORK",
          "PRACTICAL_SIMULATION",
          "VERIFIED_WALKTHROUGH",
        ],
        dimensions: Object.keys(t.applicability).filter(
          (d) => t.applicability[d],
        ),
        minCases: 1,
        freshnessDays: 365,
        expiryDays: 365,
        retentionClass: "ASSESSMENT",
        acceptanceChecks: [t.criterion],
      },
      ownerCode: input.ownerCode,
      guide: `Source: ${source.sourceDocument}; original task ${t.sourceTaskRef}; section ${t.section}. ${t.evidence || t.measure}. Review applicability, safety controls, scenario, scope and benchmark policy before publication.`,
      practicalScenario: `Demonstrate this task using an authorized practical case: ${t.criterion}`,
      knowledgePrompts: [
        `Explain the reasons, risks, limits and acceptance checks for: ${t.criterion}`,
      ],
      workTypeMappings: [],
    });
    const row = await tx.assessmentTaskVersion.create({
      data: {
        tenantId: env.tenantId,
        taskCode: t.taskCode,
        taskVersion: 1,
        familyCode,
        sectionCode: definition.sectionCode,
        ownerCode: input.ownerCode,
        createdByCode: env.who.employeeCode,
        definition: json(definition),
      },
    });
    created.push(row.id);
  }
  const result = {
    id: env.tenantId,
    created: created.length,
    skipped: skipped.length,
    source: libraryIndex.find((l) => l.namespace === input.namespace),
    status: "DRAFT",
    requiresOwnerReview: true,
  };
  await audit(tx, env, "CATALOG_LIBRARY_IMPORT", env.tenantId, input, result, {
    createdRefs: created,
  });
  return result;
}
