import { z } from "zod";
import { EvaluationForm } from "@trusoft/contracts/recruitment-assessment";
import { run, fail } from "./base.js";
const permission = (action) => "hr.recruitment.assessment." + action;
const tables = { form: "scorecard_templates", question: "InterviewQuestion" };
const models = { form: "scorecardTemplate", question: "interviewQuestion" };
const plain = z
  .string()
  .trim()
  .min(1)
  .max(10000)
  .refine((v) => !/<[^>]*>/u.test(v), "Use plain text");
export const InterviewQuestionDefinition = z
  .object({
    competencyKey: z.string().trim().min(1).max(100),
    prompt: plain.refine((v) => v.length >= 10),
    followUps: z.array(plain.max(2000)).max(10),
    goodAnswerGuide: plain.refine((v) => v.length >= 10),
    level: z.enum(["JUNIOR", "INTERMEDIATE", "SENIOR"]),
  })
  .strict();
const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(10000).nullable();
const rows = (tx, kind, sql, ...args) =>
  tx.$queryRawUnsafe(
    sql.replaceAll("$TABLE", '"' + tables[kind] + '"'),
    ...args,
  );
async function get(tx, env, kind, id, lock = false) {
  const found = await rows(
    tx,
    kind,
    'SELECT * FROM $TABLE WHERE "tenantId"=$1::uuid AND id=$2' +
      (lock ? " FOR UPDATE" : ""),
    env.tenantId,
    Number(id),
  );
  if (!found[0] || (kind === "form" && !found[0].sections))
    fail("Evaluation record not found", 404);
  return found[0];
}
function check(row, input) {
  if (
    !Number.isInteger(input.expectedVersion) ||
    row.revision !== input.expectedVersion
  )
    fail("This record changed; reload before saving", 412, "HR-6005");
}
async function audit(tx, env, action, kind, id) {
  await tx.log.create({
    data: {
      tenantId: env.tenantId,
      employeeId: env.who.id,
      actionById: env.who.id,
      type: action,
      action_type: action,
      module: "Recruitment evaluation catalog",
      result: "SUCCESS",
      ip: env.ctx.ip ?? "unknown",
      os: "server",
      notes: kind + ":" + id,
      correlationId: env.ctx.correlationId ?? null,
    },
  });
}
async function insert(tx, env, kind, data, old) {
  let familyId,
    version = 1;
  if (old) {
    familyId = old.familyId;
    await tx.$queryRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtext($1))::text",
      env.tenantId + ":" + familyId,
    );
    const latest = await rows(
      tx,
      kind,
      'SELECT max(version) AS version FROM $TABLE WHERE "tenantId"=$1::uuid AND "familyId"=$2::uuid',
      env.tenantId,
      familyId,
    );
    version = latest[0].version + 1;
  }
  const payload = {
    ...data,
    tenantId: env.tenantId,
    createdById: env.who.id,
    status: "DRAFT",
    version,
    ...(familyId ? { familyId } : {}),
  };
  const jsonFields = new Set(["sections", "criteria", "followUps"]);
  const entries = Object.entries(payload),
    values = entries.map(([k, v]) =>
      jsonFields.has(k) ? JSON.stringify(v) : v,
    );
  const columns = entries.map(([k]) => '"' + k + '"').join(",");
  const placeholders = entries
    .map(
      ([k], i) =>
        "$" +
        (i + 1) +
        (jsonFields.has(k)
          ? "::jsonb"
          : ["tenantId", "familyId"].includes(k)
            ? "::uuid"
            : ""),
    )
    .join(",");
  const result = await rows(
    tx,
    kind,
    "INSERT INTO $TABLE (" +
      columns +
      (kind === "form" ? ",updated_at" : "") +
      ") VALUES (" +
      placeholders +
      (kind === "form" ? ",now()" : "") +
      ") RETURNING *",
    ...values,
  );
  await audit(tx, env, "CREATE", kind, result[0].id);
  return result[0];
}
async function validateQuestions(tx, env, form, { published = false } = {}) {
  for (const criterion of form.sections.flatMap((s) => s.criteria)) {
    const ids = [...new Set(criterion.questionIds)];
    if (ids.length !== criterion.questionIds.length)
      fail("Suggested questions must be distinct");
    const found = await tx.interviewQuestion.findMany({
      where: {
        tenantId: env.tenantId,
        id: { in: ids },
        competencyKey: criterion.competencyKey,
        ...(published
          ? { status: "PUBLISHED" }
          : { status: { not: "RETIRED" } }),
      },
    });
    if (found.length !== ids.length)
      fail(
        "Choose company questions matching the criterion competency" +
          (published ? "; all questions must be published" : ""),
      );
  }
}
export const catalogList = (kind, input = {}) =>
  run(
    permission("read"),
    async (tx, env) => {
      const limit = Math.min(200, Math.max(1, input.limit ?? 30));
      const found = await rows(
        tx,
        kind,
        'SELECT * FROM $TABLE WHERE "tenantId"=$1::uuid AND id>$2 AND ($3::text IS NULL OR status=$3)' +
          (kind === "form"
            ? " AND sections IS NOT NULL"
            : ' AND ($5::text IS NULL OR "competencyKey"=$5)') +
          " ORDER BY id LIMIT $4",
        env.tenantId,
        input.cursor ?? 0,
        input.status || null,
        limit + 1,
        ...(kind === "question" ? [input.competencyKey || null] : []),
      );
      const items = found.slice(0, limit);
      return {
        items,
        nextCursor: found.length > limit ? items.at(-1).id : null,
        actorEmployeeId: env.who.id,
      };
    },
    "evaluationForms",
  );
export const catalogGet = (kind, input) =>
  run(
    permission("read"),
    (tx, env) => get(tx, env, kind, input.id),
    "evaluationForms",
  );
export const formCreate = (input) =>
  run(
    permission("create"),
    async (tx, env) => {
      const form = EvaluationForm.parse(input.form);
      if (form.generation)
        fail("Generation metadata is assigned when an interview is scheduled");
      await validateQuestions(tx, env, form);
      return insert(
        tx,
        env,
        "form",
        {
          name: title.parse(input.name),
          description: description.parse(input.description ?? null),
          ...form,
          criteria: form.sections.flatMap((s) => s.criteria),
        },
        null,
      );
    },
    "evaluationForms",
  );
export const formUpdate = (input) =>
  run(
    permission("update"),
    async (tx, env) => {
      const old = await get(tx, env, "form", input.templateId, true);
      check(old, input);
      if (old.status === "DRAFT" && old.createdById !== env.who.id)
        fail("Only the author can edit this draft", 403);
      const form = EvaluationForm.parse(
        input.form ?? {
          sections: old.sections,
          requiresTraining: old.requiresTraining,
          interviewType: old.interviewType,
          panelRole: old.panelRole,
        },
      );
      if (form.generation)
        fail("Generation metadata is assigned when an interview is scheduled");
      await validateQuestions(tx, env, form);
      const data = {
        name: title.parse(input.name ?? old.name),
        description: description.parse(
          input.description === undefined ? old.description : input.description,
        ),
        ...form,
        criteria: form.sections.flatMap((s) => s.criteria),
      };
      if (old.status !== "DRAFT") return insert(tx, env, "form", data, old);
      await tx.scorecardTemplate.update({ where: { id: old.id }, data });
      await audit(tx, env, "UPDATE", "form", old.id);
      return get(tx, env, "form", old.id);
    },
    "evaluationForms",
  );
export const questionSave = (input) =>
  run(
    permission(input.id ? "update" : "create"),
    async (tx, env) => {
      const data = InterviewQuestionDefinition.parse(input.question);
      if (!input.id) return insert(tx, env, "question", data, null);
      const old = await get(tx, env, "question", input.id, true);
      check(old, input);
      if (old.status !== "DRAFT") return insert(tx, env, "question", data, old);
      if (old.createdById !== env.who.id)
        fail("Only the author can edit this draft", 403);
      await tx.interviewQuestion.update({ where: { id: old.id }, data });
      await audit(tx, env, "UPDATE", "question", old.id);
      return get(tx, env, "question", old.id);
    },
    "evaluationForms",
  );
export const publish = (kind, input) =>
  run(
    permission("publish"),
    async (tx, env) => {
      const old = await get(tx, env, kind, input.id, true);
      check(old, input);
      if (old.status !== "DRAFT") fail("Only a draft can be published", 409);
      if (old.createdById === env.who.id)
        fail("An independent reviewer must publish this record", 403);
      if (kind === "form") {
        const definition = EvaluationForm.parse({
          sections: old.sections,
          requiresTraining: old.requiresTraining,
          interviewType: old.interviewType,
          panelRole: old.panelRole,
        });
        await validateQuestions(tx, env, definition, { published: true });
      } else
        InterviewQuestionDefinition.parse({
          competencyKey: old.competencyKey,
          prompt: old.prompt,
          followUps: old.followUps,
          goodAnswerGuide: old.goodAnswerGuide,
          level: old.level,
        });
      await tx[models[kind]].update({
        where: { id: old.id },
        data: { status: "PUBLISHED" },
      });
      await audit(tx, env, "PUBLISH", kind, old.id);
      return get(tx, env, kind, old.id);
    },
    "evaluationForms",
  );
export const retire = (kind, input) =>
  run(
    permission("publish"),
    async (tx, env) => {
      const old = await get(tx, env, kind, input.id ?? input.templateId, true);
      check(old, input);
      await tx[models[kind]].update({
        where: { id: old.id },
        data: {
          status: "RETIRED",
          ...(kind === "form" ? { isActive: false } : {}),
        },
      });
      if (kind === "form")
        await tx.scorecardTemplateLink.updateMany({
          where: { tenantId: env.tenantId, templateId: old.id },
          data: { isActive: false },
        });
      await audit(tx, env, "RETIRE", kind, old.id);
      return get(tx, env, kind, old.id);
    },
    "evaluationForms",
  );
export const formLink = (input) =>
  run(
    permission("publish"),
    async (tx, env) => {
      const form = await get(tx, env, "form", input.templateId, true);
      if (form.status !== "PUBLISHED" || !form.isActive)
        fail("Assign an active published form");
      const scope = input.scopeType;
      if (
        ![
          "REQUISITION",
          "JOB_FAMILY",
          "INTERVIEW_TYPE",
          "PANEL_ROLE",
          "STAGE",
        ].includes(scope)
      )
        fail("Unknown form assignment scope");
      const scopeId = ["REQUISITION", "JOB_FAMILY"].includes(scope)
        ? Number(input.scopeId)
        : null;
      const scopeKey = scopeId
        ? null
        : z.string().trim().min(1).max(80).parse(input.scopeKey);
      if (["REQUISITION", "JOB_FAMILY"].includes(scope)) {
        const found = await tx[
          scope === "REQUISITION" ? "jobRequisition" : "position"
        ].findFirst({ where: { tenantId: env.tenantId, id: scopeId || 0 } });
        if (!found) fail("Assignment target not found", 404);
      }
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext($1))::text",
        env.tenantId + ":form-link:" + scope + ":" + (scopeId ?? scopeKey),
      );
      await tx.scorecardTemplateLink.updateMany({
        where: {
          tenantId: env.tenantId,
          scopeType: scope,
          scopeId,
          scopeKey,
          isActive: true,
        },
        data: { isActive: false },
      });
      const existing = await tx.scorecardTemplateLink.findFirst({
        where: {
          tenantId: env.tenantId,
          templateId: form.id,
          scopeType: scope,
          scopeId,
          scopeKey,
        },
      });
      const result = existing
        ? await tx.scorecardTemplateLink.update({
            where: { id: existing.id },
            data: { isActive: true },
          })
        : await tx.scorecardTemplateLink.create({
            data: {
              tenantId: env.tenantId,
              templateId: form.id,
              scopeType: scope,
              scopeId,
              scopeKey,
              createdById: env.who.id,
            },
          });
      await audit(tx, env, "ASSIGN", "form", form.id);
      return result;
    },
    "evaluationForms",
  );
