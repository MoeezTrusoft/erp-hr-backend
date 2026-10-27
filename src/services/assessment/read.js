import { z } from "zod";
import {
  ASSESSMENT_SCALE,
  AssessmentRef,
  EmployeeCode,
} from "@trusoft/contracts/assessment";
import { getCtx } from "../../mcp/context.js";
import { run, config, has, fail, json, assignmentAccess } from "./base.js";
import { brief } from "./evidence.js";
import { snapshot, calculateVelocity } from "./workflow.js";
import { catalogFamilies, libraryIndex } from "./catalog-library.js";
import { workforceForecast } from "./forecast.js";
export const ListQuery = z
  .object({
    view: z
      .enum([
        "INBOX",
        "CALIBRATION",
        "RATER_METRICS",
        "TASKS",
        "PROFILES",
        "CATEGORIES",
        "QUALIFICATIONS",
        "BENCHMARKS",
        "EXCEPTIONS",
        "DEVELOPMENT",
        "APPRAISALS",
        "AMENDMENTS",
        "JD",
        "AUDIT",
        "CONFIGURATION",
        "IDENTITIES",
        "TRIGGERS",
        "EVENTS",
        "CAPABILITIES",
        "NOTIFICATIONS",
        "OPPORTUNITIES",
        "OPTIONS",
        "LIBRARY",
        "EQUIVALENCE",
        "DASHBOARD",
        "FORECAST",
      ])
      .default("INBOX"),
    employeeCode: EmployeeCode.optional(),
    cursor: AssessmentRef.optional(),
    pageSize: z.number().int().min(1).max(100).default(30),
  })
  .strict();
const mapping = {
  RATER_METRICS: [
    "assessmentIntegration",
    "hr.assessment_catalog.approve",
    { kind: "RATER_METRICS" },
  ],
  EQUIVALENCE: [
    "assessmentIntegration",
    "hr.assessment_catalog.read",
    { kind: "EQUIVALENCE" },
  ],
  TASKS: ["assessmentTaskVersion", "hr.assessment_catalog.read"],
  PROFILES: ["assessmentProfileVersion", "hr.assessment_catalog.read"],
  CATEGORIES: ["assessmentCategory", "hr.assessment_catalog.read"],
  QUALIFICATIONS: ["assessmentQualification", "hr.assessment_catalog.read"],
  BENCHMARKS: ["assessmentBenchmark", "hr.assessment_benchmark.read"],
  EXCEPTIONS: ["assessmentException", "hr.assessment_automation.manage"],
  DEVELOPMENT: [
    "assessmentIntegration",
    "hr.assessment_development.approve",
    { kind: "DEVELOPMENT" },
  ],
  JD: ["assessmentIntegration", "hr.assessment_jd.approve", { kind: "JD" }],
  APPRAISALS: ["assessmentAppraisalInput", "hr.assessment.read"],
  AUDIT: ["assessmentAudit", "hr.assessment_audit.read"],
  IDENTITIES: ["assessmentIdentity", "hr.assessment_automation.manage"],
  TRIGGERS: ["assessmentTriggerPolicy", "hr.assessment_automation.manage"],
  EVENTS: ["assessmentInboxEvent", "hr.assessment_automation.manage"],
  CAPABILITIES: ["assessmentCapability", "hr.capability.read"],
  OPPORTUNITIES: [
    "assessmentIntegration",
    "hr.assessment.self",
    { kind: "OPPORTUNITY" },
  ],
  AMENDMENTS: [
    "assessmentIntegration",
    "hr.assessment.read",
    { kind: "APPRAISAL_AMENDMENT" },
  ],
};
export async function list(raw) {
  const input = ListQuery.parse(raw),
    ctx = getCtx();
  const permission =
    mapping[input.view]?.[1] ||
    (input.view === "FORECAST"
      ? "hr.capability.read"
      : input.view === "CONFIGURATION"
        ? "hr.assessment_automation.manage"
        : has(ctx, "hr.assessment.read")
          ? "hr.assessment.read"
          : "hr.assessment.self");
  return run(permission, async (tx, env) => {
    if (input.view === "FORECAST") {
      const report = await workforceForecast(tx, env);
      const start = input.cursor
        ? report.items.findIndex((r) => r.id === input.cursor) + 1
        : 0;
      if (input.cursor && !start)
        fail(
          "CURSOR_CHANGED",
          "Forecast changed; refresh from the first page",
          409,
        );
      const items = report.items.slice(start, start + input.pageSize);
      return {
        ...report,
        items,
        nextCursor:
          start + input.pageSize < report.items.length ? items.at(-1).id : null,
      };
    }
    if (input.view === "CALIBRATION") {
      const owner = has(ctx, "hr.assessment_catalog.approve");
      const rows = await tx.assessmentIntegration.findMany({
        where: {
          tenantId: env.tenantId,
          OR: [
            {
              kind: "CALIBRATION_REFERENCE",
              ...(owner ? {} : { status: "APPROVED" }),
            },
            {
              kind: "CALIBRATION_ATTEMPT",
              ...(owner ? {} : { employeeCode: env.who.employeeCode }),
            },
          ],
        },
        take: input.pageSize + 1,
        orderBy: { id: "asc" },
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const more = rows.length > input.pageSize;
      if (more) rows.pop();
      return json({
        items: rows.map((r) =>
          r.kind === "CALIBRATION_REFERENCE" && !owner
            ? {
                ...r,
                payload: {
                  ...r.payload,
                  items: r.payload.items.map(({ expectedScore, ...i }) => i),
                },
              }
            : r,
        ),
        nextCursor: more ? rows.at(-1).id : null,
        actorCode: env.who.employeeCode,
      });
    }
    if (input.view === "LIBRARY") {
      if (!has(ctx, "hr.assessment_catalog.read"))
        fail("FORBIDDEN", "Catalogue permission is required", 403);
      return {
        families: catalogFamilies,
        libraries: libraryIndex,
        notice:
          "The guide enumerates 41 families. Department coverage is determined from approved company mappings.",
      };
    }
    if (input.view === "OPTIONS") {
      if (
        ![
          "hr.assessment.create",
          "hr.assessment_catalog.read",
          "hr.assessment_automation.manage",
          "hr.assessment.update",
          "hr.assessment_development.approve",
        ].some((p) => has(ctx, p))
      )
        fail("FORBIDDEN", "Assessment authoring permission is required", 403);
      const employees = await tx.assessmentIdentity.findMany({
        where: { tenantId: env.tenantId, active: true },
        select: { employeeCode: true },
        take: 2000,
        orderBy: { employeeCode: "asc" },
      });
      const profiles = await tx.assessmentProfileVersion.findMany({
        where: { tenantId: env.tenantId, status: "PUBLISHED" },
        select: {
          id: true,
          profileCode: true,
          profileVersion: true,
          definition: true,
        },
        take: 1000,
      });
      const tasks = await tx.assessmentTaskVersion.findMany({
        where: { tenantId: env.tenantId, status: "PUBLISHED" },
        select: {
          id: true,
          taskCode: true,
          taskVersion: true,
          definition: true,
        },
        take: 2000,
      });
      const categories = await tx.assessmentCategory.findMany({
        where: { tenantId: env.tenantId, active: true },
        select: { categoryCode: true, label: true },
      });
      const courses = await tx.trainingCourse.findMany({
        where: { tenantId: env.tenantId },
        select: { id: true, title: true },
        take: 1000,
      });
      const positions = await tx.position.findMany({
        where: { tenantId: env.tenantId },
        select: { id: true, title: true },
        take: 1000,
      });
      const cfg = await config(tx, env.tenantId);
      const pendingReviews = has(ctx, "hr.assessment.approve")
        ? await tx.assessmentAssignment.findMany({
            where: {
              tenantId: env.tenantId,
              reviewerCode: env.who.employeeCode,
              state: "UNDER_REVIEW",
            },
            take: 30,
          })
        : [];
      const reviewPackets = [];
      for (const a of pendingReviews) {
        const revision = await tx.assessmentRevision.findFirst({
          where: {
            tenantId: env.tenantId,
            assessmentRef: a.id,
            revisionNo: a.revisionNo,
          },
        });
        if (revision?.reviewTier === "BATCH")
          reviewPackets.push({
            assessmentRef: a.id,
            expectedVersion: a.version,
            employeeCode: a.employeeCode,
            period: a.period,
            revisionDigest: revision.digest,
            checks: revision.snapshot.checks,
            summaries: revision.snapshot.summaries,
          });
      }
      return json({
        employees,
        profiles,
        tasks,
        categories,
        courses,
        reviewPackets,
        positions,
        departments: cfg.departments || [],
        families: catalogFamilies,
        libraries: libraryIndex,
        scale: ASSESSMENT_SCALE,
      });
    }
    if (input.view === "CONFIGURATION")
      return { ...(await config(tx, env.tenantId)), scale: ASSESSMENT_SCALE };
    if (input.view === "DASHBOARD") {
      if (!has(ctx, "hr.assessment.read"))
        fail("FORBIDDEN", "Assessment reporting permission is required", 403);
      const [states, capability, exceptions, evidence, deadLetters] =
        await Promise.all([
          tx.assessmentAssignment.groupBy({
            by: ["state"],
            where: { tenantId: env.tenantId },
            _count: true,
          }),
          tx.assessmentCapability.groupBy({
            by: ["dimension", "status"],
            where: { tenantId: env.tenantId },
            _count: true,
          }),
          tx.assessmentException.count({
            where: { tenantId: env.tenantId, status: "OPEN" },
          }),
          tx.assessmentEvidence.groupBy({
            by: ["source", "scanState"],
            where: { tenantId: env.tenantId },
            _count: true,
          }),
          tx.assessmentInboxEvent.count({
            where: { tenantId: env.tenantId, status: "DEAD_LETTER" },
          }),
        ]);
      const forecasts = [];
      for (const days of [90, 180])
        forecasts.push({
          days,
          expiring: await tx.assessmentCapability.count({
            where: {
              tenantId: env.tenantId,
              status: "CURRENT",
              expiresAt: {
                lte: new Date(env.now.getTime() + days * 86400000),
                gt: env.now,
              },
            },
          }),
        });
      return {
        states,
        capability,
        exceptions,
        evidence,
        deadLetters,
        forecasts,
        scale: ASSESSMENT_SCALE,
      };
    }
    const [table, , extra = {}] = mapping[input.view] || [
      input.view === "NOTIFICATIONS"
        ? "assessmentNotification"
        : "assessmentAssignment",
    ];
    const where = { tenantId: env.tenantId, ...extra };
    if (
      input.employeeCode &&
      [
        "INBOX",
        "DEVELOPMENT",
        "JD",
        "APPRAISALS",
        "IDENTITIES",
        "CAPABILITIES",
        "QUALIFICATIONS",
        "NOTIFICATIONS",
      ].includes(input.view)
    )
      where.employeeCode = input.employeeCode;
    if (input.view === "NOTIFICATIONS")
      where.employeeCode = env.who.employeeCode;
    if (
      input.view === "OPPORTUNITIES" &&
      !has(ctx, "hr.assessment_automation.manage")
    )
      where.payload = { path: ["raterCode"], equals: env.who.employeeCode };
    if (input.view === "INBOX" && !has(ctx, "hr.assessment.read"))
      where.OR = [
        { employeeCode: { in: env.who.historicalCodes } },
        { raterCode: { in: env.who.historicalCodes } },
        { reviewerCode: { in: env.who.historicalCodes } },
      ];
    const rows = await tx[table].findMany({
      where,
      take: input.pageSize + 1,
      orderBy: { id: "asc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const more = rows.length > input.pageSize;
    if (more) rows.pop();
    // Internal migration IDs and raw incoming source events never leave this boundary.
    const impacts =
      input.view === "TASKS"
        ? await tx.assessmentIntegration.findMany({
            where: {
              tenantId: env.tenantId,
              kind: "CATALOG_IMPACT",
              sourceRef: { in: rows.map((r) => r.id) },
            },
          })
        : [];
    const items = rows.map((row) => {
      const { employeeRowId, payload, ...safe } = row;
      return input.view === "EVENTS"
        ? safe
        : {
            ...safe,
            ...(payload ? { payload } : {}),
            ...(input.view === "TASKS"
              ? {
                  impactComparison:
                    impacts.find((i) => i.sourceRef === row.id)?.payload ||
                    null,
                }
              : {}),
          };
    });
    return json({
      items,
      nextCursor: more ? rows.at(-1).id : null,
      scale: ASSESSMENT_SCALE,
      actorCode: env.who.employeeCode,
      actorCodes: env.who.historicalCodes,
    });
  });
}
export const GetQuery = z
  .object({
    locale: z.enum(["en", "ur"]).optional(),
    assessmentRef: AssessmentRef,
    taskCode: z.string().optional(),
    includeGuide: z.boolean().default(false),
  })
  .strict();
export async function get(raw) {
  const input = GetQuery.parse(raw),
    ctx = getCtx();
  return run(
    has(ctx, "hr.assessment.read")
      ? "hr.assessment.read"
      : "hr.assessment.self",
    async (tx, env) => {
      const a = await tx.assessmentAssignment.findFirst({
        where: { tenantId: env.tenantId, id: input.assessmentRef },
      });
      assignmentAccess(env, a);
      const snap = await snapshot(tx, env, a);
      const revision = await tx.assessmentRevision.findFirst({
        where: {
          tenantId: env.tenantId,
          assessmentRef: a.id,
          revisionNo: a.revisionNo,
        },
      });
      const guide = input.includeGuide
        ? await tx.assessmentGuideVersion.findFirst({
            where: { tenantId: env.tenantId, id: a.profileSnapshot.guideRef },
          })
        : undefined;
      const display = await config(tx, env.tenantId);
      if (input.locale) display.policy.locale = input.locale;
      if (guide && display.policy.locale !== "en") {
        const locale = display.policy.locale,
          translated = guide.content.translations?.[locale];
        guide.content = {
          ...guide.content,
          ...(translated
            ? { title: translated.title, instructions: translated.guide }
            : {}),
          tasks: guide.content.tasks.map((t) => ({
            ...t,
            ...(t.translations?.[locale] || {}),
          })),
        };
        guide.displayLocale = locale;
      }
      const evidenceBrief = input.taskCode
        ? await brief(tx, env, a, input.taskCode)
        : undefined;
      const signatures = await tx.assessmentSignOff.findMany({
        where: { tenantId: env.tenantId, assessmentRef: a.id },
        orderBy: { createdAt: "asc" },
      });
      return json({
        assignment: a,
        noteDraftFamilies: display.policy.noteDraftFamilies,
        locale: display.policy.locale,
        labels: display.translations,
        observations: snap.observations,
        summaries: snap.summaries,
        checks: snap.checks,
        links: snap.links,
        revision,
        guide,
        evidenceBrief,
        signatures: signatures.map(
          ({ actorPrincipal, tenantId, ...signature }) => signature,
        ),
        scale: ASSESSMENT_SCALE,
        actorCode: env.who.employeeCode,
        actorCodes: env.who.historicalCodes,
      });
    },
  );
}
export const VelocityPreview = z
  .object({
    assessmentRef: AssessmentRef,
    taskCode: z.string().min(1),
    timingSampleRefs: z.array(AssessmentRef),
    methodVerified: z.boolean(),
    methodNote: z.string().max(2000),
    qualityStatus: z.enum([
      "ACCEPTED",
      "REWORK_ACCEPTED",
      "FAILED",
      "INCOMPLETE",
      "STOPPED_CONTROL",
    ]),
    criticalFailure: z.boolean(),
    evidenceLinks: z.array(
      z
        .object({
          ref: AssessmentRef,
          state: z.enum(["CONFIRMED", "REJECTED"]),
          contributionConfirmed: z.boolean(),
          acceptanceConfirmed: z.boolean(),
          behaviorCheck: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export async function previewVelocity(raw) {
  const input = VelocityPreview.parse(raw);
  return run("hr.assessment.update", async (tx, env) => {
    const a = await tx.assessmentAssignment.findFirst({
      where: { tenantId: env.tenantId, id: input.assessmentRef },
    });
    assignmentAccess(env, a, true);
    const task = a.profileSnapshot.tasks.find(
      (t) => t.taskCode === input.taskCode,
    );
    if (!task) fail("TASK_OUT_OF_SCOPE", "Task not in assessment");
    const b = await brief(tx, env, a, input.taskCode);
    if (
      input.evidenceLinks.some((l) => !b.evidence.some((e) => e.id === l.ref))
    )
      fail("EVIDENCE_SCOPE", "Evidence is not visible", 403);
    return calculateVelocity(
      tx,
      env,
      a,
      task,
      input,
      input.qualityStatus,
      input.criticalFailure,
      input.evidenceLinks,
    );
  });
}
