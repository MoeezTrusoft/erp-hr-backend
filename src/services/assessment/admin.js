import { propagateEmployeeCode } from "../employee-code.service.js";
import { z } from "zod";
import {
  AssessmentRef,
  EmployeeCode,
  code,
  instant,
} from "@trusoft/contracts/assessment";
import {
  run,
  config,
  identity,
  fail,
  audit,
  event,
  hash,
  json,
  cas,
  exception,
} from "./base.js";
import { reconcileIdentities } from "./catalog.js";
import { proposeJobDescription } from "./downstream.js";
import { importCatalogLibrary } from "./catalog-library.js";
import { qualifiedCandidates } from "./workflow.js";
import { approveBatch } from "./batch-review.js";
import {
  CalibrationCommands,
  calibrationPermission,
  calibrate,
} from "./calibration.js";

export const AdministrationCommand = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("BATCH_APPROVE"),
      items: z
        .array(
          z
            .object({
              assessmentRef: AssessmentRef,
              expectedVersion: z.number().int().positive(),
              revisionDigest: z.string().length(64),
            })
            .strict(),
        )
        .min(1)
        .max(30),
      declaration: z.string().min(20),
    })
    .strict(),
  ...CalibrationCommands,
  z
    .object({
      action: z.literal("REQUEST_RESTORATION"),
      employeeCode: EmployeeCode,
      profileRef: AssessmentRef,
      restrictionRef: AssessmentRef,
      dueAt: instant,
      reason: z.string().min(30),
    })
    .strict(),
  z.object({ action: z.literal("VERIFY_IDENTITIES") }).strict(),
  z
    .object({
      action: z.literal("IMPORT_CATALOG_LIBRARY"),
      namespace: z.enum(["NET-ENG", "NET-OPS", "SW"]),
      ownerCode: EmployeeCode,
    })
    .strict(),
  z
    .object({
      action: z.literal("CATEGORY"),
      categoryCode: code,
      label: z.string().min(2).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("BIND_PROFILE"),
      employeeCode: EmployeeCode,
      profileRef: AssessmentRef,
      effectiveFrom: instant,
      reason: z.string().min(10),
    })
    .strict(),
  z
    .object({
      action: z.literal("CORRECT_CODE"),
      oldCode: EmployeeCode,
      newCode: EmployeeCode,
      reason: z.string().min(10),
    })
    .strict(),
  z
    .object({
      action: z.literal("REQUEST_ACK_EXCEPTION"),
      assessmentRef: AssessmentRef,
      reason: z.string().min(20),
      contactEvidenceRefs: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("APPROVE_ACK_EXCEPTION"),
      exceptionRef: AssessmentRef,
      expectedVersion: z.number().int().positive(),
      declaration: z.string().min(20),
    })
    .strict(),
  z
    .object({
      action: z.literal("RESTORE"),
      restrictionRef: AssessmentRef,
      restorationRevisionRef: AssessmentRef,
      declaration: z.string().min(20),
    })
    .strict(),
  z
    .object({
      action: z.literal("TRIGGER_POLICY"),
      triggerType: z.enum([
        "INITIAL",
        "RENEWAL",
        "ROLE_CHANGE",
        "OPPORTUNISTIC",
        "RESTORATION",
        "DEVELOPMENT",
        "CAMPAIGN",
        "DISPUTE",
      ]),
      enabled: z.boolean(),
      familyCodes: z.array(code),
      dueDays: z.number().int().min(1).max(365),
      dailyCap: z.number().int().min(1).max(100),
      expectedVersion: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("REPLAY_EVENT"),
      eventRef: AssessmentRef,
      reason: z.string().min(10),
    })
    .strict(),
  z
    .object({
      action: z.literal("PROPOSE_JD"),
      profileRef: AssessmentRef,
      employeeCode: EmployeeCode,
      reason: z.string().min(10),
    })
    .strict(),
  z
    .object({
      action: z.literal("LAUNCH_CAMPAIGN"),
      profileRef: AssessmentRef,
      employeeCodes: z.array(EmployeeCode).min(1).max(1000),
      period: code,
      dueAt: instant,
      reason: z.string().min(10),
    })
    .strict(),
  z
    .object({
      action: z.literal("OFFER_OPPORTUNITY"),
      employeeCode: EmployeeCode,
      raterCode: EmployeeCode,
      profileRef: AssessmentRef,
      taskCodes: z.array(code).min(1),
      caseRef: AssessmentRef,
      dueAt: instant,
      reason: z.string().min(10),
    })
    .strict(),
  z
    .object({
      action: z.literal("OPPORTUNITY_DECISION"),
      ref: AssessmentRef,
      expectedSequence: z.number().int().nonnegative(),
      decision: z.enum(["ACCEPT", "DEFER"]),
      reason: z.string().min(10),
    })
    .strict(),
  z
    .object({
      action: z.literal("RESOLVE_EXCEPTION"),
      exceptionRef: AssessmentRef,
      expectedVersion: z.number().int().positive(),
      reason: z.string().min(20),
      evidenceRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("RECORD_RECOVERY"),
      exceptionRef: AssessmentRef,
      expectedVersion: z.number().int().positive(),
      reason: z.string().min(20),
      evidenceRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("SCAN_RECEIPT"),
      evidenceRef: AssessmentRef,
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      scanRef: z.string().min(1),
      result: z.enum(["CLEAN", "MALICIOUS"]),
      mimeType: z.enum([
        "application/pdf",
        "image/png",
        "image/jpeg",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ]),
      byteSize: z.number().int().positive().max(26214400),
      inspectedAt: instant,
    })
    .strict(),
]);
export async function administer(raw) {
  const input = AdministrationCommand.parse(raw);
  if (input.action === "BATCH_APPROVE") return approveBatch(input);
  const permission = input.action.includes("CALIBRATION")
    ? calibrationPermission(input.action)
    : input.action === "SCAN_RECEIPT"
      ? "hr.assessment_evidence.ingest"
      : input.action === "OPPORTUNITY_DECISION"
        ? "hr.assessment.self"
        : input.action === "RESTORE"
          ? "hr.assessment.release"
          : input.action.includes("ACK_EXCEPTION")
            ? "hr.assessment.approve"
            : input.action === "PROPOSE_JD"
              ? "hr.assessment_jd.approve"
              : "hr.assessment_automation.manage";
  return run(
    permission,
    async (tx, env) => {
      let result;
      if (input.action.includes("CALIBRATION"))
        return calibrate(tx, env, input);
      if (input.action === "VERIFY_IDENTITIES")
        return reconcileIdentities(tx, env);
      if (input.action === "IMPORT_CATALOG_LIBRARY")
        return importCatalogLibrary(tx, env, input);
      if (input.action === "REQUEST_RESTORATION") {
        await identity(tx, env.tenantId, input.employeeCode);
        const restriction = await tx.assessmentRestriction.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.restrictionRef,
            employeeCode: input.employeeCode,
            liftedAt: null,
          },
        });
        const profile = await tx.assessmentProfileVersion.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.profileRef,
            status: "PUBLISHED",
          },
        });
        const bound = await tx.employeeAssessmentProfile.findFirst({
          where: {
            tenantId: env.tenantId,
            employeeCode: input.employeeCode,
            profileRef: input.profileRef,
            effectiveFrom: { lte: env.now },
            effectiveUntil: null,
          },
        });
        if (
          !restriction ||
          !profile ||
          !bound ||
          Date.parse(input.dueAt) <= +env.now ||
          !profile.definition.requirements.some(
            (r) => r.taskCode === restriction.taskCode,
          )
        )
          fail(
            "RESTORATION_SCOPE",
            "Select an active restriction and the employee’s current published profile with a future due date",
          );
        result = await tx.assessmentIntegration.upsert({
          where: {
            tenantId_kind_key: {
              tenantId: env.tenantId,
              kind: "RESTORATION_REQUEST",
              key: restriction.id,
            },
          },
          create: {
            tenantId: env.tenantId,
            employeeCode: input.employeeCode,
            kind: "RESTORATION_REQUEST",
            key: restriction.id,
            sourceRef: profile.id,
            status: "QUEUED",
            payload: {
              ...input,
              taskCodes: [restriction.taskCode],
              requestedByCode: env.who.employeeCode,
            },
          },
          update: {},
        });
      } else if (input.action === "SCAN_RECEIPT") {
        if (
          !process.env.ASSESSMENT_SCAN_PRINCIPAL ||
          env.ctx.servicePrincipal !== process.env.ASSESSMENT_SCAN_PRINCIPAL
        )
          fail(
            "SCANNER_IDENTITY",
            "Only the authenticated malware scanner may issue a scan receipt",
            403,
          );
        const e = await tx.assessmentEvidence.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.evidenceRef,
            origin: "MANUAL_UPLOAD",
            contentHash: input.contentHash,
            scanState: "QUARANTINED",
          },
        });
        if (!e || Math.abs(env.now - Date.parse(input.inspectedAt)) > 3600000)
          fail(
            "SCAN_RECEIPT_INVALID",
            "A recent scan of the exact quarantined evidence version is required",
          );
        result = await tx.assessmentEvidence.update({
          where: { id: e.id },
          data: {
            scanState: input.result === "CLEAN" ? "CLEAN" : "REJECTED",
            integrityFlags:
              input.result === "CLEAN" ? [] : ["MALWARE_DETECTED"],
          },
        });
      } else if (
        ["RESOLVE_EXCEPTION", "RECORD_RECOVERY"].includes(input.action)
      ) {
        const e = await tx.assessmentException.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.exceptionRef,
            status: "OPEN",
          },
        });
        if (!e || ["ACKNOWLEDGMENT_EXCEPTION", "DISPUTE"].includes(e.kind))
          fail(
            "EXCEPTION_WORKFLOW",
            "Use the dedicated independent approval workflow",
          );
        const cfg = await config(tx, env.tenantId);
        if (e.key === "IDENTITY_QUALITY")
          fail(
            "IDENTITY_RECONCILIATION_REQUIRED",
            "Identity quality is resolved only by the automated reconciliation after corrections",
          );
        if (input.action === "RECORD_RECOVERY") {
          result = await cas(
            tx,
            "assessmentException",
            e,
            input.expectedVersion,
            {
              stableSince: env.now,
              detail: {
                ...e.detail,
                recovery: {
                  at: env.now.toISOString(),
                  reason: input.reason,
                  evidenceRef: input.evidenceRef,
                  verifiedByCode: env.who.employeeCode,
                },
              },
            },
          );
          await audit(tx, env, input.action, result.id, input, result);
          return json(result);
        }
        if (
          e.kind === "CIRCUIT_BREAKER" &&
          (!e.stableSince ||
            env.now - e.stableSince < cfg.policy.stableMinutes * 60000)
        )
          fail(
            "STABILITY_REQUIRED",
            "Record recovery evidence, then allow the configured stable period before resuming",
          );
        result = await cas(
          tx,
          "assessmentException",
          e,
          input.expectedVersion,
          {
            status: "RESOLVED",
            resolvedAt: env.now,
            detail: {
              ...e.detail,
              resolution: {
                reason: input.reason,
                evidenceRef: input.evidenceRef,
                approvedByCode: env.who.employeeCode,
              },
            },
          },
        );
      } else if (
        input.action === "LAUNCH_CAMPAIGN" ||
        input.action === "OFFER_OPPORTUNITY"
      ) {
        const profile = await tx.assessmentProfileVersion.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.profileRef,
            status: "PUBLISHED",
          },
        });
        if (!profile || Date.parse(input.dueAt) <= +env.now)
          fail(
            "CAMPAIGN_SCOPE",
            "A published profile and future due date are required",
          );
        const codes = input.employeeCodes || [input.employeeCode],
          items = [];
        for (const employeeCode of new Set(codes)) {
          const employee = await identity(tx, env.tenantId, employeeCode);
          if (input.action === "OFFER_OPPORTUNITY") {
            const tasks = await tx.assessmentTaskVersion.findMany({
              where: {
                tenantId: env.tenantId,
                taskCode: { in: input.taskCodes },
                status: "PUBLISHED",
              },
            });
            const families = [...new Set(tasks.map((t) => t.familyCode))],
              candidates = await qualifiedCandidates(
                tx,
                env,
                employee,
                families,
              );
            const rater = candidates.find(
              (c) => c.employeeCode === input.raterCode,
            );
            if (
              !rater ||
              rater.onLeave ||
              rater.employeeCode === employeeCode ||
              rater.managerCode === employeeCode ||
              families.some(
                (f) =>
                  !rater.qualifications.some(
                    (q) =>
                      q.familyCode === f &&
                      q.expiresAt > env.now &&
                      q.calibration.passed &&
                      !q.flags.includes("DISQUALIFIED"),
                  ),
              )
            )
              fail(
                "RATER_UNQUALIFIED",
                "Offer the observation to a qualified independent rater",
              );
          }
          if (
            !(await tx.employeeAssessmentProfile.findFirst({
              where: {
                tenantId: env.tenantId,
                employeeCode,
                profileRef: profile.id,
                effectiveUntil: null,
              },
            }))
          )
            fail(
              "CAMPAIGN_SCOPE",
              "Every selected employee needs this approved profile",
            );
          const kind =
            input.action === "LAUNCH_CAMPAIGN"
              ? "CAMPAIGN_REQUEST"
              : "OPPORTUNITY";
          if (
            input.caseRef &&
            !(await tx.assessmentCase.findFirst({
              where: {
                tenantId: env.tenantId,
                id: input.caseRef,
                employeeCode,
              },
            }))
          )
            fail(
              "EVIDENCE_SCOPE",
              "Opportunity case must belong to this employee",
            );
          const key = hash({
            profileRef: profile.id,
            employeeCode,
            period: input.period,
            caseRef: input.caseRef,
          });
          items.push(
            await tx.assessmentIntegration.upsert({
              where: {
                tenantId_kind_key: { tenantId: env.tenantId, kind, key },
              },
              create: {
                tenantId: env.tenantId,
                employeeCode,
                kind,
                key,
                sourceRef: profile.id,
                status: kind === "OPPORTUNITY" ? "OFFERED" : "QUEUED",
                payload: json({
                  ...input,
                  employeeCodes: undefined,
                  employeeCode,
                  approvedByCode: env.who.employeeCode,
                }),
              },
              update: {},
            }),
          );
        }
        result = { id: profile.id, items };
      } else if (input.action === "OPPORTUNITY_DECISION") {
        const row = await tx.assessmentIntegration.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.ref,
            payload: { path: ["raterCode"], equals: env.who.employeeCode },
            kind: "OPPORTUNITY",
            status: { in: ["OFFERED", "DEFERRED"] },
          },
        });
        if (!row || row.sequence !== input.expectedSequence)
          fail(
            "STALE_VERSION",
            "Opportunity changed or is not assigned to you",
            409,
          );
        result = await tx.assessmentIntegration.update({
          where: { id: row.id },
          data: {
            status: input.decision === "ACCEPT" ? "QUEUED" : "DEFERRED",
            sequence: { increment: 1 },
            payload: { ...row.payload, decisionReason: input.reason },
          },
        });
      } else if (input.action === "CATEGORY") {
        result = await tx.assessmentCategory.upsert({
          where: {
            tenantId_categoryCode: {
              tenantId: env.tenantId,
              categoryCode: input.categoryCode,
            },
          },
          create: {
            tenantId: env.tenantId,
            categoryCode: input.categoryCode,
            label: input.label,
          },
          update: { label: input.label, version: { increment: 1 } },
        });
      } else if (input.action === "BIND_PROFILE") {
        const employee = await identity(tx, env.tenantId, input.employeeCode);
        const profile = await tx.assessmentProfileVersion.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.profileRef,
            status: "PUBLISHED",
          },
        });
        if (!profile || String(employee.positionRef) !== profile.positionRef)
          fail(
            "ROLE_MAPPING",
            "Profile must match the employee’s current position",
          );
        const from = new Date(input.effectiveFrom);
        if (from < new Date(env.now.getTime() - 86400000))
          fail("BACKDATED_PROFILE", "Use a current or future effective date");
        await tx.employeeAssessmentProfile.updateMany({
          where: {
            tenantId: env.tenantId,
            employeeCode: input.employeeCode,
            effectiveUntil: null,
          },
          data: { effectiveUntil: from, version: { increment: 1 } },
        });
        result = await tx.employeeAssessmentProfile.create({
          data: {
            tenantId: env.tenantId,
            employeeCode: input.employeeCode,
            profileRef: profile.id,
            effectiveFrom: from,
            approvedByCode: env.who.employeeCode,
          },
        });
        await tx.assessmentIdentity.update({
          where: { id: employee.id },
          data: {
            categoryCode: profile.categoryCode,
            departmentRef: profile.departmentRef,
          },
        });
      } else if (input.action === "CORRECT_CODE") {
        const employee = await identity(tx, env.tenantId, input.oldCode);
        if (
          input.oldCode === input.newCode ||
          (await tx.assessmentIdentity.findFirst({
            where: { tenantId: env.tenantId, employeeCode: input.newCode },
          })) ||
          (await tx.assessmentCodeChange.findFirst({
            where: {
              tenantId: env.tenantId,
              OR: [{ oldCode: input.newCode }, { newCode: input.newCode }],
            },
          }))
        )
          fail(
            "CODE_COLLISION",
            "The new employee code must be unused, including historical codes",
          );
        if (employee.employeeCode === env.who.employeeCode)
          fail(
            "SELF_APPROVAL",
            "Another authorized HR owner must approve this correction",
            403,
          );
        result = await propagateEmployeeCode(tx, { tenantId: env.tenantId, oldCode: input.oldCode, newCode: input.newCode, actorCode: env.who.employeeCode, reason: input.reason, effectiveAt: env.now });
      } else if (input.action === "REQUEST_ACK_EXCEPTION") {
        const a = await tx.assessmentAssignment.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.assessmentRef,
            state: "ACKNOWLEDGMENT_DUE",
          },
        });
        if (!a || a.employeeCode === env.who.employeeCode)
          fail(
            "INVALID_STATE",
            "An independent request for an acknowledgment-due assessment is required",
          );
        result = await exception(
          tx,
          env,
          `ack:${a.id}`,
          "ACKNOWLEDGMENT_EXCEPTION",
          a.id,
          {
            reason: input.reason,
            contactEvidenceRefs: input.contactEvidenceRefs,
            requestedByCode: env.who.employeeCode,
          },
        );
      } else if (input.action === "APPROVE_ACK_EXCEPTION") {
        const e = await tx.assessmentException.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.exceptionRef,
            kind: "ACKNOWLEDGMENT_EXCEPTION",
            status: "OPEN",
          },
        });
        if (!e || e.detail.requestedByCode === env.who.employeeCode)
          fail(
            "INDEPENDENT_APPROVAL",
            "A separate approver must review the acknowledgment exception",
            403,
          );
        const a = await tx.assessmentAssignment.findFirst({
          where: { tenantId: env.tenantId, id: e.scopeRef },
        });
        if ([a.employeeCode, a.raterCode].includes(env.who.employeeCode))
          fail(
            "INDEPENDENT_APPROVAL",
            "Employee and rater cannot approve an acknowledgment exception",
            403,
          );
        result = await cas(
          tx,
          "assessmentException",
          e,
          input.expectedVersion,
          {
            status: "APPROVED",
            resolvedAt: env.now,
            detail: {
              ...e.detail,
              approvedByCode: env.who.employeeCode,
              declaration: input.declaration,
            },
          },
        );
      } else if (input.action === "RESTORE") {
        const restriction = await tx.assessmentRestriction.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.restrictionRef,
            liftedAt: null,
          },
        });
        const revision = await tx.assessmentRevision.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.restorationRevisionRef,
            state: "PUBLISHED",
          },
        });
        const a =
          revision &&
          (await tx.assessmentAssignment.findFirst({
            where: {
              tenantId: env.tenantId,
              id: revision.assessmentRef,
              purpose: { in: ["RESTORATION", "DISPUTE"] },
            },
          }));
        const obs = revision?.snapshot.observations.find(
          (o) => o.taskCode === restriction?.taskCode,
        );
        if (
          !restriction ||
          !a ||
          a.employeeCode !== restriction.employeeCode ||
          [a.employeeCode, a.raterCode].includes(env.who.employeeCode) ||
          !obs ||
          obs.criticalFailure ||
          obs.dimensions.some(
            (d) =>
              ["K", "S"].includes(d.dimension) &&
              (d.status !== "RATED" || d.score < 3),
          )
        )
          fail(
            "RESTORATION_EVIDENCE",
            "A new, independently approved practical restoration assessment meeting K3/S3 is required",
          );
        result = await tx.assessmentRestriction.update({
          where: { id: restriction.id },
          data: {
            liftedAt: env.now,
            liftedByCode: env.who.employeeCode,
            restorationRef: revision.id,
          },
        });
        if (
          !(await tx.assessmentRestriction.findFirst({
            where: {
              tenantId: env.tenantId,
              employeeCode: a.employeeCode,
              taskCode: restriction.taskCode,
              liftedAt: null,
            },
          }))
        )
          await tx.assessmentCapability.updateMany({
            where: {
              tenantId: env.tenantId,
              employeeCode: a.employeeCode,
              taskCode: restriction.taskCode,
              revisionRef: revision.id,
              expiresAt: { gt: env.now },
              score: { not: null },
            },
            data: { status: "CURRENT" },
          });
        await event(tx, env, "hr.capability.restored.v1", result.id, {
          employeeCode: a.employeeCode,
          taskCode: restriction.taskCode,
          revisionRef: revision.id,
          restrictionRef: result.id,
        });
      } else if (input.action === "TRIGGER_POLICY") {
        const prior = await tx.assessmentTriggerPolicy.findFirst({
          where: { tenantId: env.tenantId, triggerType: input.triggerType },
        });
        const data = {
          enabled: input.enabled,
          scopeFilter: { familyCodes: input.familyCodes },
          policy: { dueDays: input.dueDays, dailyCap: input.dailyCap },
        };
        result = prior
          ? await cas(
              tx,
              "assessmentTriggerPolicy",
              prior,
              input.expectedVersion,
              data,
            )
          : input.expectedVersion === 0
            ? await tx.assessmentTriggerPolicy.create({
                data: {
                  tenantId: env.tenantId,
                  triggerType: input.triggerType,
                  ...data,
                },
              })
            : fail("STALE_VERSION", "Trigger changed", 409);
      } else if (input.action === "REPLAY_EVENT") {
        const e = await tx.assessmentInboxEvent.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.eventRef,
            status: "DEAD_LETTER",
          },
        });
        if (!e) fail("NOT_FOUND", "Dead-letter event not found", 404);
        result = await tx.assessmentInboxEvent.update({
          where: { id: e.id },
          data: {
            status: "PENDING",
            attempts: 0,
            nextAttemptAt: env.now,
            leaseUntil: null,
          },
        });
      } else if (input.action === "PROPOSE_JD") {
        const profile = await tx.assessmentProfileVersion.findFirst({
          where: {
            tenantId: env.tenantId,
            id: input.profileRef,
            status: "PUBLISHED",
          },
        });
        if (!profile) fail("NOT_FOUND", "Published profile not found", 404);
        result = await proposeJobDescription(
          tx,
          env,
          profile,
          input.employeeCode,
          input.reason,
        );
      }
      await audit(tx, env, input.action, result.id, input, result);
      return json(result);
    },
    {
      requireActor: !["VERIFY_IDENTITIES", "SCAN_RECEIPT"].includes(
        input.action,
      ),
    },
  );
}
