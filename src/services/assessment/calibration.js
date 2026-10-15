import { z } from "zod";
import {
  AssessmentRef,
  Score,
  code,
  instant,
} from "@trusoft/contracts/assessment";
import { audit, config, fail, hash, identity, json } from "./base.js";
const referenceItem = z
  .object({
    caseCode: code,
    taskCode: code,
    dimension: z.enum(["K", "S", "V"]),
    scenario: z.string().min(30).max(4000),
    expectedScore: Score,
  })
  .strict();
export const CalibrationCommands = [
  z
    .object({
      action: z.literal("CREATE_CALIBRATION_REFERENCE"),
      familyCode: code,
      scopes: z.array(code).min(1),
      title: z.string().min(5).max(200),
      expiresAt: instant,
      items: z.array(referenceItem).min(3).max(100),
      declaration: z.string().min(20),
    })
    .strict(),
  z
    .object({
      action: z.literal("APPROVE_CALIBRATION_REFERENCE"),
      ref: AssessmentRef,
      expectedSequence: z.number().int().nonnegative(),
      declaration: z.string().min(20),
    })
    .strict(),
  z
    .object({
      action: z.literal("SUBMIT_CALIBRATION"),
      ref: AssessmentRef,
      answers: z
        .array(
          z
            .object({
              caseCode: code,
              dimension: z.enum(["K", "S", "V"]),
              score: Score,
              rationale: z.string().min(10).max(2000),
            })
            .strict(),
        )
        .min(3)
        .max(100),
      declaration: z.string().min(20),
    })
    .strict(),
];
export function calibrationPermission(action) {
  return action === "SUBMIT_CALIBRATION"
    ? "hr.assessment.self"
    : action === "CREATE_CALIBRATION_REFERENCE"
      ? "hr.assessment_catalog.update"
      : "hr.assessment_catalog.approve";
}
export async function calibrate(tx, env, input) {
  let result;
  if (input.action === "CREATE_CALIBRATION_REFERENCE") {
    if (Date.parse(input.expiresAt) <= +env.now)
      fail("CALIBRATION_EXPIRY", "Choose a future reference expiry");
    const keys = input.items.map((i) => `${i.caseCode}:${i.dimension}`);
    if (
      new Set(keys).size !== keys.length ||
      new Set(input.items.map((i) => i.caseCode)).size < 3
    )
      fail(
        "CALIBRATION_CASES",
        "Use at least three distinct cases with unique case/dimension decisions",
      );
    const tasks = await tx.assessmentTaskVersion.findMany({
      where: {
        tenantId: env.tenantId,
        familyCode: input.familyCode,
        status: "PUBLISHED",
        taskCode: { in: input.items.map((i) => i.taskCode) },
      },
    });
    if (
      input.items.some(
        (i) =>
          !tasks.some(
            (t) =>
              t.taskCode === i.taskCode &&
              t.definition.applicability[i.dimension] &&
              (input.scopes.includes("*") ||
                input.scopes.includes(t.definition.scope)),
          ),
      )
    )
      fail(
        "CALIBRATION_SCOPE",
        "Cases must belong to applicable published tasks in the declared family and scope",
      );
    result = await tx.assessmentIntegration.create({
      data: {
        tenantId: env.tenantId,
        employeeCode: env.who.employeeCode,
        kind: "CALIBRATION_REFERENCE",
        key: hash(input),
        sourceRef: input.familyCode,
        status: "PROPOSED",
        payload: json({
          ...input,
          authorCode: env.who.employeeCode,
          scaleVersion: "KSV-1",
        }),
      },
    });
  } else {
    const reference = await tx.assessmentIntegration.findFirst({
      where: {
        tenantId: env.tenantId,
        id: input.ref,
        kind: "CALIBRATION_REFERENCE",
      },
    });
    if (!reference) fail("NOT_FOUND", "Calibration reference not found", 404);
    if (input.action === "APPROVE_CALIBRATION_REFERENCE") {
      if (reference.employeeCode === env.who.employeeCode)
        fail(
          "SELF_APPROVAL",
          "A separate qualified owner must review the reference ratings",
          403,
        );
      if (
        reference.status !== "PROPOSED" ||
        reference.sequence !== input.expectedSequence
      )
        fail("STALE_VERSION", "Calibration reference changed", 409);
      result = await tx.assessmentIntegration.update({
        where: { id: reference.id },
        data: {
          status: "APPROVED",
          sequence: { increment: 1 },
          payload: {
            ...reference.payload,
            reviewedByCode: env.who.employeeCode,
            reviewedAt: env.now.toISOString(),
          },
        },
      });
    } else {
      if (
        reference.status !== "APPROVED" ||
        Date.parse(reference.payload.expiresAt) <= +env.now
      )
        fail("CALIBRATION_REFERENCE", "Select a current reviewed reference");
      if (
        [reference.employeeCode, reference.payload.reviewedByCode].includes(
          env.who.employeeCode,
        )
      )
        fail(
          "CALIBRATION_CONFLICT",
          "The reference author and reviewer must calibrate against independently prepared cases",
          403,
        );
      const prior = await tx.assessmentIntegration.findFirst({
        where: {
          tenantId: env.tenantId,
          kind: "CALIBRATION_ATTEMPT",
          employeeCode: env.who.employeeCode,
          sourceRef: reference.id,
        },
      });
      if (prior) {
        if (prior.payload.inputDigest !== hash(input))
          fail(
            "CALIBRATION_RETAKE",
            "Use a different reviewed reference for a fresh attempt",
          );
        return prior;
      }
      const answers = new Map(
        input.answers.map((a) => [`${a.caseCode}:${a.dimension}`, a]),
      );
      if (
        answers.size !== input.answers.length ||
        answers.size !== reference.payload.items.length
      )
        fail(
          "CALIBRATION_ANSWERS",
          "Rate each reference case/dimension exactly once",
        );
      const cfg = await config(tx, env.tenantId),
        results = [];
      for (const item of reference.payload.items) {
        const answer = answers.get(`${item.caseCode}:${item.dimension}`);
        if (!answer)
          fail("CALIBRATION_ANSWERS", "A reference decision is missing");
        results.push({
          ...answer,
          expectedScore: item.expectedScore,
          deviation: Math.abs(answer.score - item.expectedScore),
        });
      }
      const agreement = Object.fromEntries(
        ["K", "S", "V"].map((d) => {
          const rows = results.filter((r) => r.dimension === d);
          return [
            d,
            rows.length
              ? rows.filter((r) => r.deviation === 0).length / rows.length
              : null,
          ];
        }),
      );
      const passed =
        Object.values(agreement)
          .filter((v) => v != null)
          .every((v) => v >= cfg.policy.calibrationAgreementMin) &&
        results.every((r) => r.deviation <= cfg.policy.calibrationMaxDeviation);
      result = await tx.assessmentIntegration.create({
        data: {
          tenantId: env.tenantId,
          employeeCode: env.who.employeeCode,
          kind: "CALIBRATION_ATTEMPT",
          key: `${reference.id}:${env.who.employeeCode}`,
          sourceRef: reference.id,
          status: passed ? "PASSED" : "REFRESHER_REQUIRED",
          payload: json({
            familyCode: reference.payload.familyCode,
            scopes: reference.payload.scopes,
            scaleVersion: "KSV-1",
            expiresAt: reference.payload.expiresAt,
            agreement,
            results,
            inputDigest: hash(input),
            policyVersion: cfg.version,
            passed,
            declaration: input.declaration,
            submittedAt: env.now,
          }),
        },
      });
    }
  }
  await audit(tx, env, input.action, result.id, input, {
    ref: result.id,
    status: result.status,
  });
  return result;
}
export async function verifiedCalibration(tx, env, input) {
  await identity(tx, env.tenantId, input.employeeCode);
  const attempt = await tx.assessmentIntegration.findFirst({
    where: {
      tenantId: env.tenantId,
      id: input.calibrationRef,
      kind: "CALIBRATION_ATTEMPT",
      employeeCode: input.employeeCode,
      status: "PASSED",
    },
  });
  if (
    !attempt ||
    attempt.payload.familyCode !== input.familyCode ||
    attempt.payload.scaleVersion !== "KSV-1" ||
    Date.parse(attempt.payload.expiresAt) < Date.parse(input.expiresAt) ||
    input.scopes.some(
      (s) =>
        !attempt.payload.scopes.includes(s) &&
        !attempt.payload.scopes.includes("*"),
    )
  )
    fail(
      "CALIBRATION_REQUIRED",
      "Qualification requires this employee’s passed, current in-system calibration for the same family, scope and expiry",
    );
  return {
    passed: true,
    reference: attempt.id,
    agreement: attempt.payload.agreement,
    scaleVersion: "KSV-1",
    verifiedAt: env.now.toISOString(),
  };
}
