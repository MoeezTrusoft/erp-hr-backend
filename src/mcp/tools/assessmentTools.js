import { z } from "zod";
import {
  planningSnapshot,
  PlanningQuery,
} from "../../services/assessment/planning.js";
import {
  AssignmentCommand,
  ObservationCommand,
  WorkflowCommand,
  WorkEvidenceEvent,
  ManualCaseCommand,
} from "@trusoft/contracts/assessment";
import { withToolError } from "../utils/toolError.js";
import {
  configure,
  ConfigurationCommand,
  createCatalog,
  CatalogCommand,
  transitionCatalog,
  CatalogTransition,
  qualify,
  QualificationCommand,
} from "../../services/assessment/catalog.js";
import {
  assign,
  saveObservation,
  workflow,
} from "../../services/assessment/workflow.js";
import {
  ingest,
  createManualCase,
  manageBenchmark,
  BenchmarkCommand,
} from "../../services/assessment/evidence.js";
import {
  administer,
  AdministrationCommand,
} from "../../services/assessment/admin.js";
import {
  decideIntegration,
  IntegrationCommand,
} from "../../services/assessment/downstream.js";
import {
  list,
  ListQuery,
  get,
  GetQuery,
  previewVelocity,
  VelocityPreview,
} from "../../services/assessment/read.js";
import {
  EquivalenceCommand,
  manageEquivalence,
} from "../../services/assessment/equivalence.js";
import { NoteCommand, draftNote } from "../../services/assessment/notes.js";
import {
  ExportCommand,
  exportAssessment,
} from "../../services/assessment/export.js";
export const assessmentTools = [
  [
    "hr_assessment_note_draft",
    "Create a clearly labeled factual note suggestion with no rating",
    NoteCommand,
    draftNote,
  ],
  [
    "hr_assessment_export",
    "Export an authorized immutable assessment revision with an audit record",
    ExportCommand,
    exportAssessment,
  ],
  [
    "hr_assessment_catalog_equivalence",
    "Propose and independently approve explicit task-version equivalence",
    EquivalenceCommand,
    manageEquivalence,
  ],
  [
    "hr_assessment_planning_snapshot",
    "Read current code-scoped capability and published working calendars for PM",
    PlanningQuery,
    planningSnapshot,
  ],
  [
    "hr_assessment_list",
    "List company-scoped assessment work and administration queues",
    ListQuery,
    list,
  ],
  [
    "hr_assessment_get",
    "Read an assessment, evidence brief and separate rater guide",
    GetQuery,
    get,
  ],
  [
    "hr_assessment_configure",
    "Configure approved assessment policies, source mappings and rollout gates",
    ConfigurationCommand,
    configure,
  ],
  [
    "hr_assessment_catalog_create",
    "Create an immutable task or role-profile draft",
    CatalogCommand,
    createCatalog,
  ],
  [
    "hr_assessment_catalog_transition",
    "Submit, independently review, publish or retire a catalogue version",
    CatalogTransition,
    transitionCatalog,
  ],
  [
    "hr_assessment_qualify",
    "Record independently verified assessor qualification and calibration",
    QualificationCommand,
    qualify,
  ],
  [
    "hr_assessment_assign",
    "Assign a published role profile to a verified employee code",
    AssignmentCommand,
    assign,
  ],
  [
    "hr_assessment_observation_save",
    "Save deliberate task-level K/S ratings and confirmed calculated V",
    ObservationCommand,
    saveObservation,
  ],
  [
    "hr_assessment_velocity_preview",
    "Calculate velocity without creating or changing an observed rating",
    VelocityPreview,
    previewVelocity,
  ],
  [
    "hr_assessment_workflow",
    "Submit, review, acknowledge, dispute, publish or revoke a revision",
    WorkflowCommand,
    workflow,
  ],
  [
    "hr_assessment_evidence_ingest",
    "Accept a deduplicated event from a registered evidence source",
    WorkEvidenceEvent,
    ingest,
  ],
  [
    "hr_assessment_case_create",
    "Record an assessor-observed practical case or quarantined upload",
    ManualCaseCommand,
    createManualCase,
  ],
  [
    "hr_assessment_benchmark",
    "Propose and prospectively approve a benchmark with sample provenance",
    BenchmarkCommand,
    manageBenchmark,
  ],
  [
    "hr_assessment_admin",
    "Manage verified identities, role profiles, triggers and governed exceptions",
    AdministrationCommand,
    administer,
  ],
  [
    "hr_assessment_integration_decide",
    "Approve development actions or a role-owner-reviewed JD proposal",
    IntegrationCommand,
    decideIntegration,
  ],
];
export function registerAssessmentTools(server) {
  for (const [name, description, schema, handler] of assessmentTools)
    server.registerTool(
      name,
      { description, inputSchema: advertisedObjectSchema(schema) },
      withToolError(
        async (args) => ({
          content: [
            { type: "text", text: JSON.stringify(await handler(args)) },
          ],
        }),
        name,
      ),
    );
}
// SDK tools/list requires an object at the root. Preserve union fields in the
// manifest while validating the original discriminated command on every call.
export function advertisedObjectSchema(schema) {
  if (schema.shape) return schema;
  if (!schema.options) throw new Error("Unsupported assessment command schema");
  const keys = [
    ...new Set(schema.options.flatMap((s) => Object.keys(s.shape))),
  ];
  const shape = Object.fromEntries(
    keys.map((key) => {
      const variants = schema.options.map((s) => s.shape[key]).filter(Boolean);
      const value = variants.length === 1 ? variants[0] : z.union(variants);
      return [
        key,
        variants.length === schema.options.length ? value : value.optional(),
      ];
    }),
  );
  return z
    .object(shape)
    .strict()
    .superRefine((value, ctx) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        for (const issue of parsed.error.issues) ctx.addIssue(issue);
    });
}
