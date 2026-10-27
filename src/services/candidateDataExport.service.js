import { createHash } from "node:crypto";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { currentCorrelationId } from "../lib/requestContext.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import {
  CANDIDATE_EXPORT_FIELDS,
  CANDIDATE_EXPORT_SOURCES,
} from "./candidateDataExport.catalog.js";
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status, code: "HR-5702" });
};
const select = (fields) => Object.fromEntries(fields.map((f) => [f, true]));
const redactSecurityFields = (value) =>
  Array.isArray(value)
    ? value.map(redactSecurityFields)
    : value && typeof value === "object" && !(value instanceof Date)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(
              ([key]) =>
                !/^(token|tokenHash|accessToken|accessTokenHash|sessionCode|sessionCodeHash|encryptedPayload|identityCipher|signingUrlCipher|answerKey|answerKeyCiphertext|correctAnswer|correctAnswers|password|secret|authorization|leaseToken)$/i.test(
                  key,
                ),
            )
            .map(([key, child]) => [key, redactSecurityFields(child)]),
        )
      : value;
const rawSources = {
  interviewStaffNotice: {
    table: "InterviewStaffNotice",
    column: "interviewId",
  },
  interviewSlotOffer: { table: "InterviewSlotOffer", column: "applicationId" },
  offerLetterVersion: { table: "offer_letter_versions", column: "candidateId" },
  offerSignatureRequest: {
    table: "offer_signature_requests",
    column: "candidateId",
  },
};
const ids = (rows) => rows.map((row) => row.id);
const scopeFields = {
  candidate: "candidateId",
  application: "applicationId",
  interview: "interviewId",
  session: "sessionId",
  offer: "offerId",
  handoff: "handoffId",
  checklist: "checklistId",
};
export async function exportCandidateDataRequest({ tenantId, id }) {
  const { who } = await requireRecruitmentActor({
    tenantId,
    permission: "hr.recruitment.update",
    allowedScopes: ["ORG"],
    adminOnly: true,
  });
  const requestId = Number(id);
  if (!Number.isSafeInteger(requestId) || requestId <= 0)
    fail("A valid request id is required", 400);
  return tenantTransaction(
    prisma,
    async (db) => {
      const request = await db.candidateDataAccessRequest.findFirst({
        where: { tenantId, id: requestId },
      });
      if (!request) fail("Data access request not found", 404);
      if (
        request.type !== "ACCESS" ||
        ["FULFILLED", "REJECTED"].includes(request.status)
      )
        fail("Only an open access request can be exported");
      if (!request.candidateId)
        fail(
          "Link the verified candidate when recording an access request before generating an export",
        );
      // Same lock order as erasure: candidate, then request. A consistent snapshot
      // prevents mixing pre-erasure and post-erasure child data.
      await db.$queryRawUnsafe(
        'SELECT id FROM "Candidate" WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        request.candidateId,
        tenantId,
      );
      await db.$queryRawUnsafe(
        'SELECT id FROM candidate_data_access_requests WHERE id=$1 AND "tenantId"=$2::uuid FOR UPDATE',
        request.id,
        tenantId,
      );
      const candidate = await db.candidate.findFirst({
        where: { tenantId, id: request.candidateId },
        select: select(CANDIDATE_EXPORT_FIELDS.candidate),
      });
      if (!candidate) fail("Candidate not found", 404);
      if (
        candidate.email.trim().toLowerCase() !==
        request.subjectEmail.trim().toLowerCase()
      )
        fail("The request email does not match the linked candidate");
      const sections = { candidate: [candidate] };
      // A possible duplicate is not proof that another person's records belong
      // to this requester. Export only this review metadata, never the other identity.
      sections.duplicateSuggestions = await db.$queryRawUnsafe(
        'SELECT id,state,reasons,"reviewedAt","reviewReason","createdAt","updatedAt" FROM "CandidateDuplicateSuggestion" WHERE "tenantId"=$1::uuid AND ("leftId"=$2 OR "rightId"=$2) ORDER BY id',
        tenantId,
        candidate.id,
      );
      const query = async (
        model,
        where,
        fields = CANDIDATE_EXPORT_FIELDS[model],
      ) => {
        const rawSource = rawSources[model];
        if (rawSource) {
          // Table, columns and projection are closed code-owned catalogues.
          const columns = fields.map((f) => '"' + f + '"').join(",");
          sections[model] = await db.$queryRawUnsafe(
            "SELECT " +
              columns +
              ' FROM "' +
              rawSource.table +
              '" WHERE "tenantId"=$1::uuid AND "' +
              rawSource.column +
              '"=ANY($2::int[]) ORDER BY id',
            tenantId,
            where[rawSource.column].in,
          );
          return sections[model];
        }
        sections[model] = await db[model].findMany({
          where: { tenantId, ...where },
          select: select(fields),
          orderBy:
            model === "interviewInterviewer"
              ? { employeeId: "asc" }
              : { id: "asc" },
        });
        return sections[model];
      };
      const applications = await query("application", {
        candidateId: candidate.id,
      });
      const scopes = {
        candidate: [candidate.id],
        application: ids(applications),
      };
      scopes.interview = ids(
        await query("interview", { applicationId: { in: scopes.application } }),
      );
      scopes.offer = ids(
        await query("offer", {
          candidateId: candidate.id,
          applicationId: { in: scopes.application },
        }),
      );
      // ApplicationAnswer has no tenant column; the owned parent is mandatory.
      sections.applicationAnswer = await db.applicationAnswer.findMany({
        where: {
          applicationId: { in: scopes.application },
          application: { tenantId, candidateId: candidate.id },
        },
        select: select(CANDIDATE_EXPORT_FIELDS.applicationAnswer),
        orderBy: { id: "asc" },
      });
      await query("candidateDncEntry", {
        OR: [
          { candidateId: candidate.id },
          { email: candidate.email.toLowerCase() },
        ],
      });
      for (const source of CANDIDATE_EXPORT_SOURCES) {
        const scopeIds = scopes[source.scope] || [];
        let where = { [scopeFields[source.scope]]: { in: scopeIds } };
        if (source.model === "aiInferenceRecord")
          where = {
            OR: [
              { candidateId: candidate.id },
              { applicationId: { in: scopes.application } },
            ],
          };
        if (source.model === "candidateDataAccessRequest")
          where = {
            OR: [
              { candidateId: candidate.id },
              {
                candidateId: null,
                subjectEmail: candidate.email.toLowerCase(),
              },
            ],
          };
        const rows = await query(source.model, where, source.fields);
        if (source.model === "candidateTestSession") scopes.session = ids(rows);
        if (source.model === "offerHandoff") {
          scopes.handoff = ids(rows);
          scopes.checklist = rows.map((row) => row.checklistId).filter(Boolean);
        }
      }
      // These linked records have no candidate foreign key, so use only ids from
      // the owned recruitment records collected above.
      await query("onboardingChecklist", {
        id: { in: scopes.checklist || [] },
      });
      const mediaIds = [
        candidate.resumeMediaId,
        ...sections.candidateDocumentUpload.map((r) => r.mediaId),
      ].filter(Boolean);
      await query("resumeParseAttempt", {
        kind: "CANDIDATE",
        mediaId: { in: mediaIds },
      });
      const approvals = await query("hrApprovalRequest", {
        kind: "OFFER",
        sourceRef: { in: scopes.offer.map(String) },
      });
      await query("hrApprovalAudit", { approvalRef: { in: ids(approvals) } });
      const generatedAt = new Date().toISOString();
      const document = {
        format: "candidate-access-export.v1",
        generatedAt,
        requestId,
        candidateId: candidate.id,
        reviewRequired: true,
        coverage: {
          scope: "Candidate recruitment and linked onboarding records",
          excluded: [
            "Authentication tokens and token hashes",
            "Worker leases and encrypted delivery envelopes",
            "Assessment item bank, answer keys and frozen test-item definitions",
            "Unrelated candidates and employee records",
          ],
          documents:
            "Document references identify files held in DAM. HR must retrieve and review those files separately when fulfilling the request.",
        },
        sections: redactSecurityFields(sections),
      };
      const content = JSON.stringify(document, null, 2);
      if (Buffer.byteLength(content, "utf8") > 30 * 1024 * 1024)
        fail("The export exceeds 30 MB; arrange a supervised export", 413);
      const manifest = {
        format: document.format,
        generatedAt,
        generatedById: who.id,
        sha256: createHash("sha256").update(content).digest("hex"),
        byteLength: Buffer.byteLength(content, "utf8"),
        counts: Object.fromEntries(
          Object.entries(sections).map(([name, rows]) => [name, rows.length]),
        ),
      };
      await db.candidateDataAccessRequest.update({
        where: { id: request.id },
        data: {
          status: "IN_PROGRESS",
          handledById: who.id,
          exportManifest: manifest,
        },
      });
      await db.log.create({
        data: {
          tenantId,
          employeeId: who.id,
          actionById: who.id,
          type: "Export",
          action_type: "CANDIDATE_ACCESS_EXPORT",
          module: "Candidate Privacy",
          result: "SUCCESS",
          ip: "unknown",
          os: "server",
          notes:
            "Access request " + request.id + "; SHA-256 " + manifest.sha256,
          correlationId: currentCorrelationId() ?? null,
        },
      });
      return {
        fileName: "candidate-access-request-" + request.id + ".json",
        mediaType: "application/json",
        content,
        manifest,
      };
    },
    {
      tenantId,
      txOptions: {
        isolationLevel: "RepeatableRead",
        timeout: 30000,
        maxWait: 10000,
      },
    },
  );
}
