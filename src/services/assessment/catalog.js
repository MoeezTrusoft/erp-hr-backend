import { z } from "zod";
import {
  TaskDefinition,
  ProfileDefinition,
  AssessmentPolicy,
  EmployeeCode,
  code,
  instant,
  AssessmentRef,
} from "@trusoft/contracts/assessment";
import { lintProfile } from "@trusoft/contracts/assessment-rules";
import { verifiedCalibration } from "./calibration.js";
import { taskImpact } from "./catalog-impact.js";
import { SourceExtract } from "./source-extract.js";
import {
  run,
  fail,
  identity,
  audit,
  hash,
  json,
  cas,
  config,
  exception,
  event,
} from "./base.js";

const Source = z
  .object({
    source: code,
    enabled: z.boolean(),
    ownerCode: EmployeeCode,
    servicePrincipal: z.string().min(1),
    freshnessDays: z.number().int().positive(),
    sourcePermission: z.string().regex(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/),
    mappings: z.array(
      z
        .object({
          workType: code,
          taskCode: code,
          taskVersion: z.number().int().positive(),
          method: z.enum([
            "OBSERVED_WORK",
            "VERIFIED_WALKTHROUGH",
            "KNOWLEDGE_DEMONSTRATION",
            "PRACTICAL_SIMULATION",
          ]),
        })
        .strict(),
    ),
    classifications: z.array(
      z.enum(["INTERNAL", "CONFIDENTIAL", "FINANCE", "CUSTOMER"]),
    ),
    maxLagMinutes: z.number().int().positive(),
    confirmedAt: instant,
    extracts: z.array(SourceExtract).max(4).default([]),
  })
  .strict();
export const ConfigurationCommand = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    policy: AssessmentPolicy,
    sourceRegister: z.array(Source),
    departments: z.array(
      z
        .object({
          departmentRef: code,
          familyCodes: z.array(code).min(1),
          ownerCode: EmployeeCode,
          confirmedActive: z.boolean(),
        })
        .strict(),
    ),
    learningMappings: z.array(
      z
        .object({
          taskCode: code,
          dimension: z.enum(["K", "S", "V"]),
          courseRef: code,
          mentorCode: EmployeeCode.optional(),
        })
        .strict(),
    ),
    translations: z.record(z.string(), z.string()).default({}),
    rolloutEvidence: z
      .record(
        z.string(),
        z
          .object({
            reference: z.string().min(1),
            ownerCode: EmployeeCode,
            verifiedAt: instant,
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
export async function configure(raw) {
  const input = ConfigurationCommand.parse(raw);
  const sources = input.sourceRegister.map((s) => s.source);
  const extractKeys = input.sourceRegister.flatMap((s) =>
    s.extracts.map((e) => e.key),
  );
  if (
    new Set(sources).size !== sources.length ||
    new Set(extractKeys).size !== extractKeys.length
  )
    fail(
      "SOURCE_CONFIGURATION",
      "Source codes and extract keys must be unique within the company",
    );
  return run("hr.assessment_automation.manage", async (tx, env) => {
    const old = await config(tx, env.tenantId);
    for (const owner of [
      ...input.departments.map((d) => d.ownerCode),
      ...input.sourceRegister.map((s) => s.ownerCode),
      ...Object.values(input.rolloutEvidence).map((e) => e.ownerCode),
      ...input.learningMappings.map((m) => m.mentorCode).filter(Boolean),
    ])
      await identity(tx, env.tenantId, owner);
    const stages = [
      "FOUNDATION",
      "EVIDENCE_SHADOW",
      "PILOT",
      "HR_INTEGRATION",
      "PM_SHADOW",
      "CONTROLLED",
      "AUTOMATIC",
    ];
    const gates = [
      "identity",
      "sources",
      "pilotUat",
      "hrUat",
      "pmShadow",
      "reservationUat",
      "automaticUat",
    ];
    const stage = stages.indexOf(input.policy.stage);
    for (let i = 0; i <= stage; i++)
      if (!input.rolloutEvidence[gates[i]])
        fail("ROLLOUT_GATE", `Verified ${gates[i]} evidence is required`);
    if (
      stage >= 2 &&
      (!input.departments.length ||
        input.departments.some((d) => !d.confirmedActive))
    )
      fail(
        "DEPARTMENT_COVERAGE",
        "Verify every active department before a pilot",
      );
    if (stage >= 2) {
      const people = await tx.assessmentIdentity.findMany({
        where: { tenantId: env.tenantId, active: true },
      });
      const profiles = await tx.assessmentProfileVersion.findMany({
        where: { tenantId: env.tenantId, status: "PUBLISHED" },
      });
      const bindings = await tx.employeeAssessmentProfile.findMany({
        where: {
          tenantId: env.tenantId,
          effectiveFrom: { lte: env.now },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: env.now } }],
        },
      });
      const uncovered = people.filter(
        (p) =>
          !bindings.some(
            (b) =>
              b.employeeCode === p.employeeCode &&
              profiles.some(
                (r) =>
                  r.id === b.profileRef &&
                  r.positionRef === p.positionRef &&
                  r.guideRef &&
                  input.departments.some(
                    (d) => d.departmentRef === r.departmentRef,
                  ),
              ),
          ),
      );
      if (uncovered.length)
        fail(
          "PROFILE_COVERAGE",
          "Every active employee in the rollout company needs a current published position profile and guide",
          422,
          { employeeCodes: uncovered.map((p) => p.employeeCode) },
        );
    }
    const data = {
      policy: json(input.policy),
      sourceRegister: json(input.sourceRegister),
      departments: json(input.departments),
      learningMappings: json(input.learningMappings),
      translations: input.translations,
      rolloutEvidence: json(input.rolloutEvidence),
      updatedByCode: env.who.employeeCode,
    };
    const result = old.id
      ? await cas(
          tx,
          "assessmentConfiguration",
          old,
          input.expectedVersion,
          data,
        )
      : input.expectedVersion === 0
        ? await tx.assessmentConfiguration.create({
            data: { tenantId: env.tenantId, ...data },
          })
        : fail("STALE_VERSION", "Configuration changed", 409);
    await audit(tx, env, "CONFIGURE", result.id, input, result);
    return result;
  });
}
export const CatalogCommand = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("TASK"),
      definition: TaskDefinition,
      ref: AssessmentRef.optional(),
      expectedVersion: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("PROFILE"),
      definition: ProfileDefinition,
      ref: AssessmentRef.optional(),
      expectedVersion: z.number().int().positive().optional(),
    })
    .strict(),
]);
export async function createCatalog(raw) {
  const input = CatalogCommand.parse(raw);
  return run("hr.assessment_catalog.create", async (tx, env) => {
    const d = input.definition;
    await identity(tx, env.tenantId, d.ownerCode);
    const common = {
      tenantId: env.tenantId,
      definition: json(d),
      ownerCode: d.ownerCode,
      createdByCode: env.who.employeeCode,
    };
    let result;
    if (input.kind === "TASK") {
      if (input.ref) {
        const prior = await tx.assessmentTaskVersion.findFirst({
          where: { tenantId: env.tenantId, id: input.ref, status: "DRAFT" },
        });
        if (
          !prior ||
          prior.taskCode !== d.taskCode ||
          prior.taskVersion !== d.taskVersion
        )
          fail(
            "DRAFT_REQUIRED",
            "Only the matching draft version can be edited",
          );
        result = await cas(
          tx,
          "assessmentTaskVersion",
          prior,
          input.expectedVersion,
          {
            definition: json(d),
            ownerCode: d.ownerCode,
            familyCode: d.familyCode,
            sectionCode: d.sectionCode,
          },
        );
      } else
        result = await tx.assessmentTaskVersion.create({
          data: {
            ...common,
            taskCode: d.taskCode,
            taskVersion: d.taskVersion,
            familyCode: d.familyCode,
            sectionCode: d.sectionCode,
          },
        });
    } else {
      if (
        !(await tx.assessmentCategory.findFirst({
          where: {
            tenantId: env.tenantId,
            categoryCode: d.categoryCode,
            active: true,
          },
        }))
      )
        fail("CATEGORY_MISSING", "Create a distinct assessment category first");
      const tasks = await tx.assessmentTaskVersion.findMany({
        where: {
          tenantId: env.tenantId,
          status: "PUBLISHED",
          OR: d.requirements.map((r) => ({
            taskCode: r.taskCode,
            taskVersion: r.taskVersion,
          })),
        },
      });
      const prior = await tx.assessmentProfileVersion.findMany({
        where: {
          tenantId: env.tenantId,
          positionRef: d.positionRef,
          status: "PUBLISHED",
        },
      });
      const errors = lintProfile(
        d,
        tasks.map((t) => t.definition),
        prior.map((p) => p.definition),
      );
      if (errors.length) fail("PROFILE_INVALID", errors.join("; "));
      const impacted = await tx.employeeAssessmentProfile.findMany({
        where: {
          tenantId: env.tenantId,
          profileRef: { in: prior.map((p) => p.id) },
          effectiveUntil: null,
        },
        select: { employeeCode: true },
      });
      const profileData = {
        ...common,
        profileCode: d.profileCode,
        profileVersion: d.profileVersion,
        departmentRef: d.departmentRef,
        categoryCode: d.categoryCode,
        positionRef: d.positionRef,
        impactComparison: {
          prior: prior.map((p) => ({
            ref: p.id,
            requirements: p.definition.requirements,
          })),
          proposed: d.requirements,
          employees: impacted.map((i) => i.employeeCode),
          requiresProspectiveReassessment: true,
        },
      };
      if (input.ref) {
        const draft = await tx.assessmentProfileVersion.findFirst({
          where: { tenantId: env.tenantId, id: input.ref, status: "DRAFT" },
        });
        if (
          !draft ||
          draft.profileCode !== d.profileCode ||
          draft.profileVersion !== d.profileVersion
        )
          fail(
            "DRAFT_REQUIRED",
            "Only the matching draft profile version can be edited",
          );
        const { createdByCode: _createdByCode, ...changes } = profileData;
        result = await cas(
          tx,
          "assessmentProfileVersion",
          draft,
          input.expectedVersion,
          changes,
        );
        await tx.assessmentProfileTask.deleteMany({
          where: { tenantId: env.tenantId, profileRef: draft.id },
        });
      } else
        result = await tx.assessmentProfileVersion.create({
          data: profileData,
        });
      await tx.assessmentProfileTask.createMany({
        data: d.requirements.map((r) => ({
          tenantId: env.tenantId,
          profileRef: result.id,
          taskRef: tasks.find(
            (t) => t.taskCode === r.taskCode && t.taskVersion === r.taskVersion,
          ).id,
          taskCode: r.taskCode,
          ordinal: r.order,
          requirement: json(r),
        })),
      });
    }
    if (input.kind === "TASK")
      result = {
        ...result,
        impactComparison: await taskImpact(tx, env, result),
      };
    await audit(tx, env, "CATALOG_DRAFT", result.id, input, result);
    return result;
  });
}
export const CatalogTransition = z
  .object({
    kind: z.enum(["TASK", "PROFILE"]),
    ref: AssessmentRef,
    expectedVersion: z.number().int().positive(),
    action: z.enum(["SUBMIT", "SME_APPROVE", "PUBLISH", "RETURN", "RETIRE"]),
    declaration: z.string().min(10).max(2000),
  })
  .strict();
export async function transitionCatalog(raw) {
  const input = CatalogTransition.parse(raw);
  return run(
    input.action === "SUBMIT"
      ? "hr.assessment_catalog.update"
      : "hr.assessment_catalog.approve",
    async (tx, env) => {
      const table =
        input.kind === "TASK"
          ? "assessmentTaskVersion"
          : "assessmentProfileVersion";
      const row = await tx[table].findFirst({
        where: { id: input.ref, tenantId: env.tenantId },
      });
      if (!row) fail("NOT_FOUND", "Catalogue version not found", 404);
      const states = {
        SUBMIT: ["DRAFT", "SME_REVIEW"],
        SME_APPROVE: ["SME_REVIEW", "HR_REVIEW"],
        PUBLISH: ["HR_REVIEW", "PUBLISHED"],
        RETURN: ["SME_REVIEW", "DRAFT"],
        RETIRE: ["PUBLISHED", "RETIRED"],
      };
      const [from, to] = states[input.action];
      if (row.status !== from) fail("INVALID_STATE", `Expected ${from}`);
      if (
        input.action === "SUBMIT" &&
        input.kind === "TASK" &&
        [row.definition.complexity, row.definition.technology].includes(
          "OWNER_REVIEW_REQUIRED",
        )
      )
        fail(
          "CATALOG_REVIEW_REQUIRED",
          "Replace imported scope placeholders and verify the task definition before review",
        );
      if (
        input.action !== "SUBMIT" &&
        env.who.employeeCode === row.createdByCode
      )
        fail("SELF_APPROVAL", "A separate reviewer is required", 403);
      const reviews = await tx.assessmentAudit.findMany({
        where: {
          tenantId: env.tenantId,
          aggregateRef: row.id,
          action: "CATALOG_SME_APPROVE",
        },
      });
      if (
        input.action === "SME_APPROVE" &&
        row.ownerCode !== env.who.employeeCode
      )
        fail(
          "SME_OWNER_REQUIRED",
          "The designated catalogue owner must approve subject-matter accuracy",
          403,
        );
      if (
        input.action === "PUBLISH" &&
        reviews.some((r) => r.actorCode === env.who.employeeCode)
      )
        fail(
          "SEPARATE_REVIEW",
          "HR approval must be independent of SME approval",
          403,
        );
      const result = await cas(tx, table, row, input.expectedVersion, {
        status: to,
        ...(to === "PUBLISHED"
          ? { publishedAt: env.now, approvedByCode: env.who.employeeCode }
          : {}),
      });
      if (to === "PUBLISHED" && input.kind === "PROFILE") {
        const taskRows = await tx.assessmentTaskVersion.findMany({
          where: {
            tenantId: env.tenantId,
            OR: row.definition.requirements.map((r) => ({
              taskCode: r.taskCode,
              taskVersion: r.taskVersion,
            })),
            status: "PUBLISHED",
          },
        });
        const errors = lintProfile(
          row.definition,
          taskRows.map((t) => t.definition),
        );
        if (errors.length) fail("PROFILE_INVALID", errors.join("; "));
        const content = {
          title: row.definition.title,
          instructions: row.definition.guide,
          translations: row.definition.translations || {},
          tasks: taskRows.map((t) => ({
            taskCode: t.taskCode,
            guide: t.definition.guide,
            practicalScenario: t.definition.practicalScenario,
            knowledgePrompts: t.definition.knowledgePrompts,
            translations: t.definition.translations || {},
            evidencePolicy: t.definition.evidencePolicy,
          })),
        };
        const guide = await tx.assessmentGuideVersion.create({
          data: {
            tenantId: env.tenantId,
            profileRef: row.id,
            version: row.profileVersion,
            content,
            digest: hash(content),
          },
        });
        await tx.assessmentProfileVersion.update({
          where: { id: row.id },
          data: { guideRef: guide.id },
        });
      }
      await audit(tx, env, `CATALOG_${input.action}`, row.id, input, result, {
        declaration: input.declaration,
        attestationVersion: 1,
      });
      return result;
    },
  );
}
export const QualificationCommand = z
  .object({
    employeeCode: EmployeeCode,
    familyCode: code,
    scopes: z.array(code).min(1),
    calibrationRef: AssessmentRef,
    expiresAt: instant,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export async function qualify(raw) {
  const input = QualificationCommand.parse(raw);
  return run("hr.assessment_catalog.approve", async (tx, env) => {
    await identity(tx, env.tenantId, input.employeeCode);
    if (input.employeeCode === env.who.employeeCode)
      fail(
        "SELF_APPROVAL",
        "Raters cannot approve their own qualification",
        403,
      );
    const old = await tx.assessmentQualification.findFirst({
      where: {
        tenantId: env.tenantId,
        employeeCode: input.employeeCode,
        familyCode: input.familyCode,
      },
    });
    const data = {
      scopes: input.scopes,
      calibration: await verifiedCalibration(tx, env, input),
      flags: [],
      expiresAt: new Date(input.expiresAt),
      authorizedByCode: env.who.employeeCode,
    };
    if (data.expiresAt <= env.now)
      fail("EXPIRED_QUALIFICATION", "Qualification must expire in the future");
    const result = old
      ? await cas(
          tx,
          "assessmentQualification",
          old,
          input.expectedVersion,
          data,
        )
      : input.expectedVersion === 0
        ? await tx.assessmentQualification.create({
            data: {
              tenantId: env.tenantId,
              employeeCode: input.employeeCode,
              familyCode: input.familyCode,
              ...data,
            },
          })
        : fail("STALE_VERSION", "Qualification changed", 409);
    await audit(tx, env, "QUALIFY_RATER", result.id, input, result);
    return result;
  });
}
export async function reconcileIdentities(tx, env) {
  const employees = await tx.employee.findMany({
    where: { tenant_id: env.tenantId },
    select: {
      id: true,
      employee_code: true,
      managerId: true,
      positionId: true,
      employement_status: true,
      status: true,
    },
  });
  const counts = new Map();
  for (const e of employees) {
    const c = e.employee_code?.trim();
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
  }
  let valid = 0;
  const invalid = [];
  for (const e of employees) {
    const c = e.employee_code?.trim();
    if (!c || c.length > 50 || counts.get(c) !== 1) {
      invalid.push(e.id);
      continue;
    }
    const old = await tx.assessmentIdentity.findFirst({
      where: { tenantId: env.tenantId, employeeRowId: e.id },
    });
    if (old && old.employeeCode !== c) {
      invalid.push(e.id);
      continue;
    }
    const reused = await tx.assessmentCodeChange.findFirst({
      where: { tenantId: env.tenantId, oldCode: c },
    });
    if (reused) {
      invalid.push(e.id);
      continue;
    }
    const active = !/inactive|terminated|exited|offboard/i.test(
      `${e.employement_status || ""} ${e.status || ""}`,
    );
    const data = {
      employeeCode: c,
      employeeRowId: e.id,
      managerCode:
        employees.find((m) => m.id === e.managerId)?.employee_code?.trim() ||
        null,
      positionRef: e.positionId == null ? null : String(e.positionId),
      active,
      verifiedAt: env.now,
    };
    await tx.assessmentIdentity.upsert({
      where: {
        tenantId_employeeCode: { tenantId: env.tenantId, employeeCode: c },
      },
      create: { tenantId: env.tenantId, ...data },
      update: data,
    });
    if (
      old &&
      ((old.active && !active) || old.positionRef !== data.positionRef)
    ) {
      await event(tx, env, "hr.employee.assessment_scope_changed.v1", old.id, {
        employeeCode: c,
        reason: active ? "POSITION_CHANGED" : "OFFBOARDED",
        effectiveAt: env.now,
      });
      await tx.assessmentAssignment.updateMany({
        where: {
          tenantId: env.tenantId,
          employeeCode: c,
          state: {
            notIn: ["PUBLISHED", "REVOKED", "SUPERSEDED", "CLOSED_INCOMPLETE"],
          },
        },
        data: { state: "CLOSED_INCOMPLETE", version: { increment: 1 } },
      });
      await exception(tx, env, `scope:${c}`, "EMPLOYMENT_SCOPE_CHANGE", c, {
        employeeCode: c,
        previousPosition: old.positionRef,
        currentPosition: data.positionRef,
        active,
      });
    }
    valid++;
  }
  if (invalid.length)
    await tx.assessmentIdentity.updateMany({
      where: { tenantId: env.tenantId, employeeRowId: { in: invalid } },
      data: { active: false },
    });
  const ratio = employees.length ? valid / employees.length : 0;
  const cfg = await config(tx, env.tenantId);
  if (ratio < cfg.policy.identityThreshold)
    await exception(
      tx,
      env,
      "IDENTITY_QUALITY",
      "CIRCUIT_BREAKER",
      env.tenantId,
      { ratio, invalidCount: invalid.length },
    );
  await audit(
    tx,
    env,
    "IDENTITY_RECONCILE",
    env.tenantId,
    { count: employees.length },
    { ratio, valid, invalidCount: invalid.length },
  );
  return { ratio, valid, invalidCount: invalid.length };
}
