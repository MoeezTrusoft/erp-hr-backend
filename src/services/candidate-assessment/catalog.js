import { withPeriodExposure } from "./exposure.js";
import {
  TestItem,
  TestBlueprint,
  EvaluationForm,
} from "@trusoft/contracts/recruitment-assessment";
import { encryptString, decryptString } from "../../lib/crypto.js";
import { run, load, version, fail, has } from "./base.js";
import { validatePool } from "./rules.js";
import { runAiTask } from "../../lib/aiPlaneClient.js";
import { isRecruitmentFlagEnabled } from "../../lib/recruitmentFlags.js";
import {
  pinItemImage,
  itemImageReference,
  downloadPinnedImage,
} from "./images.js";
const permission = (k) => "hr.recruitment.assessment." + k;
const safeItem = (row) => {
  const copy = { ...row };
  delete copy.answerKey;
  return copy;
};
async function validateItemReferences(tx, env, data) {
  if (
    !(await tx.skill.findFirst({
      where: {
        id: data.skillId,
        OR: [{ tenantId: env.tenantId }, { tenantId: null }],
      },
    }))
  )
    fail("Choose a canonical or company skill");
  for (const id of data.gradeLevelIds)
    if (
      !(await tx.gradeLevel.findFirst({
        where: { tenantId: env.tenantId, id },
      }))
    )
      fail("Grade level not found");
}
export const referencesList = (input) =>
  run(permission("read"), async (tx, env) => {
    const model = input.kind === "SKILL" ? "skill" : "gradeLevel";
    const scope =
      input.kind === "SKILL"
        ? { OR: [{ tenantId: env.tenantId }, { tenantId: null }] }
        : { tenantId: env.tenantId };
    const where = {
      ...(input.kind === "SKILL"
        ? { OR: [{ tenantId: env.tenantId }, { tenantId: null }] }
        : { tenantId: env.tenantId }),
      ...(input.q ? { name: { contains: input.q, mode: "insensitive" } } : {}),
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
    };
    const rows = await tx[model].findMany({
      where,
      select: { id: true, name: true },
      orderBy: { id: "asc" },
      take: (input.limit ?? 30) + 1,
    });
    const items = rows.slice(0, input.limit ?? 30);
    const selected = input.selectedId
      ? await tx[model].findFirst({
          where: { ...scope, id: input.selectedId },
          select: { id: true, name: true },
        })
      : null;
    return {
      items,
      selected,
      nextCursor: rows.length > (input.limit ?? 30) ? items.at(-1).id : null,
    };
  });
async function saveItem(
  tx,
  env,
  input,
  { previous = null, aiDrafted = false } = {},
) {
  const data = TestItem.parse(input);
  await validateItemReferences(tx, env, data);
  const highest = await tx.candidateTestItem.findFirst({
    where: { tenantId: env.tenantId, itemCode: data.itemCode },
    orderBy: { version: "desc" },
  });
  const saved = await tx.candidateTestItem.create({
    data: {
      ...data,
      answerKey: encryptString(JSON.stringify(data.answerKey)),
      tenantId: env.tenantId,
      version: (highest?.version ?? 0) + 1,
      authorId: env.who.id,
      aiDrafted: aiDrafted || previous?.aiDrafted || false,
    },
  });
  await pinItemImage(tx, env, saved);
  return safeItem(saved);
}
export const itemsList = (input) =>
  run(permission("read"), async (tx, env) => {
    const rows = await tx.candidateTestItem.findMany({
      where: {
        tenantId: env.tenantId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.competencyKey ? { competencyKey: input.competencyKey } : {}),
        ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: (input.limit ?? 50) + 1,
    });
    const items = rows.slice(0, input.limit ?? 50).map(safeItem);
    return {
      items,
      actorEmployeeId: env.who.id,
      nextCursor: rows.length > items.length ? items.at(-1).id : null,
    };
  });
export const itemGet = (input) =>
  run(permission("read"), async (tx, env) => {
    const row = await load(tx, env, "candidateTestItem", input.id);
    const image = row.mediaId
      ? await itemImageReference(tx, env.tenantId, row.id, false)
      : null;
    row.image = image;
    return row.authorId === env.who.id || has(env, permission("publish"))
      ? { ...row, answerKey: JSON.parse(decryptString(row.answerKey)) }
      : safeItem(row);
  });
export const itemCreate = (input) =>
  run(permission("create"), (tx, env) => saveItem(tx, env, input.item));
export const itemUpdate = (input) =>
  run(permission("update"), async (tx, env) => {
    const row = await load(tx, env, "candidateTestItem", input.id, {
      lock: true,
    });
    version(row, input.expectedVersion);
    if (row.status !== "DRAFT")
      return saveItem(
        tx,
        env,
        { ...input.item, itemCode: row.itemCode },
        { previous: row },
      );
    if (row.authorId !== env.who.id)
      fail("Only the author can edit this draft", 403);
    const data = TestItem.parse(input.item);
    if (data.itemCode !== row.itemCode) fail("Item code is immutable");
    await validateItemReferences(tx, env, data);
    const saved = await tx.candidateTestItem.update({
      where: { id: row.id },
      data: {
        ...data,
        answerKey: encryptString(JSON.stringify(data.answerKey)),
        revision: { increment: 1 },
      },
    });
    await pinItemImage(tx, env, saved);
    return safeItem(saved);
  });
export const itemSubmit = (input) =>
  run(permission("update"), async (tx, env) => {
    const r = await load(tx, env, "candidateTestItem", input.id, {
      lock: true,
    });
    version(r, input.expectedVersion);
    if (r.status !== "DRAFT" || r.authorId !== env.who.id)
      fail("Only the author may submit a draft");
    if (r.mediaId)
      await downloadPinnedImage(
        await itemImageReference(tx, env.tenantId, r.id),
        env.tenantId,
      );
    return safeItem(
      await tx.candidateTestItem.update({
        where: { id: r.id },
        data: { status: "IN_REVIEW", revision: { increment: 1 } },
      }),
    );
  });
export const itemReview = (input) =>
  run(permission("publish"), async (tx, env) => {
    const r = await load(tx, env, "candidateTestItem", input.id, {
      lock: true,
    });
    version(r, input.expectedVersion);
    if (r.status !== "IN_REVIEW" || r.authorId === env.who.id)
      fail("An independent reviewer must review a submitted item", 403);
    if (input.approve && r.mediaId)
      await downloadPinnedImage(
        await itemImageReference(tx, env.tenantId, r.id),
        env.tenantId,
      );
    return safeItem(
      await tx.candidateTestItem.update({
        where: { id: r.id },
        data: {
          status: input.approve ? "PUBLISHED" : "DRAFT",
          reviewerId: env.who.id,
          reviewComment: input.reason,
          revision: { increment: 1 },
        },
      }),
    );
  });
export const itemRetire = (input) =>
  run(permission("publish"), async (tx, env) => {
    const r = await load(tx, env, "candidateTestItem", input.id, {
      lock: true,
    });
    version(r, input.expectedVersion);
    return safeItem(
      await tx.candidateTestItem.update({
        where: { id: r.id },
        data: {
          status: "RETIRED",
          reviewComment: input.reason,
          revision: { increment: 1 },
        },
      }),
    );
  });
export const itemsImport = (input) =>
  run(permission("create"), async (tx, env) => {
    if (
      !Array.isArray(input.items) ||
      !input.items.length ||
      input.items.length > 200
    )
      fail("Import one to 200 items");
    const parsed = input.items.map((row) => TestItem.parse(row));
    if (new Set(parsed.map((row) => row.itemCode)).size !== parsed.length)
      fail("Each item code must occur only once in the import");
    const items = [];
    for (const row of parsed) items.push(await saveItem(tx, env, row));
    return { items };
  });
export const itemStats = (input) =>
  run(permission("read"), async (tx, env) => {
    await load(tx, env, "candidateTestItem", input.id);
    return {
      items: await tx.candidateTestItemStat.findMany({
        where: { tenantId: env.tenantId, itemId: input.id },
        orderBy: { period: "desc" },
        take: 90,
      }),
    };
  });
export const blueprintList = (input) =>
  run(permission("read"), async (tx, env) => {
    const rows = await tx.candidateTestBlueprint.findMany({
      where: {
        tenantId: env.tenantId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: (input.limit ?? 50) + 1,
    });
    const items = rows.slice(0, input.limit ?? 50);
    return {
      items,
      actorEmployeeId: env.who.id,
      nextCursor: rows.length > items.length ? items.at(-1).id : null,
    };
  });
export const blueprintGet = (input) =>
  run(permission("read"), (tx, env) =>
    load(tx, env, "candidateTestBlueprint", input.id),
  );
export const blueprintCreate = (input) =>
  run(permission("create"), async (tx, env) => {
    const data = TestBlueprint.parse(input.blueprint);
    const previous = await tx.candidateTestBlueprint.findFirst({
      where: { tenantId: env.tenantId, name: data.name },
      orderBy: { version: "desc" },
    });
    return tx.candidateTestBlueprint.create({
      data: {
        ...data,
        tenantId: env.tenantId,
        version: (previous?.version ?? 0) + 1,
        createdById: env.who.id,
      },
    });
  });
export const blueprintUpdate = (input) =>
  run(permission("update"), async (tx, env) => {
    const r = await load(tx, env, "candidateTestBlueprint", input.id, {
      lock: true,
    });
    version(r, input.expectedVersion);
    const data = TestBlueprint.parse(input.blueprint);
    if (r.status !== "DRAFT") {
      const previous = await tx.candidateTestBlueprint.findFirst({
        where: { tenantId: env.tenantId, name: r.name },
        orderBy: { version: "desc" },
      });
      return tx.candidateTestBlueprint.create({
        data: {
          ...data,
          name: r.name,
          tenantId: env.tenantId,
          version: previous.version + 1,
          createdById: env.who.id,
        },
      });
    }
    if (r.createdById !== env.who.id)
      fail("Only the author can edit this blueprint draft", 403);
    return tx.candidateTestBlueprint.update({
      where: { id: r.id },
      data: {
        ...data,
        approvedByHiringManagerId: null,
        approvedByHrId: null,
        revision: { increment: 1 },
      },
    });
  });
export const blueprintApprove = (input) =>
  run(permission("approve"), async (tx, env) => {
    const r = await load(tx, env, "candidateTestBlueprint", input.id, {
      lock: true,
    });
    version(r, input.expectedVersion);
    if (r.status !== "DRAFT") fail("Only a draft can be approved");
    const roles = Array.isArray(env.ctx.user.roles) ? env.ctx.user.roles : [];
    const allowed =
      input.role === "HR"
        ? ["HR_ADMIN", "HR_HEAD", "HR_MANAGER"]
        : ["HIRING_MANAGER", "DEPARTMENT_MANAGER"];
    if (!roles.some((r) => allowed.includes(String(r).toUpperCase())))
      fail("The designated HR or hiring manager role is required", 403);
    const field =
        input.role === "HR" ? "approvedByHrId" : "approvedByHiringManagerId",
      other =
        input.role === "HR" ? "approvedByHiringManagerId" : "approvedByHrId";
    if (r[other] === env.who.id || r.createdById === env.who.id)
      fail("Blueprint author and approvers must be independent", 403);
    return tx.candidateTestBlueprint.update({
      where: { id: r.id },
      data: { [field]: env.who.id, revision: { increment: 1 } },
    });
  });
export const blueprintPublish = (input) =>
  run(permission("publish"), async (tx, env) => {
    const r = await load(tx, env, "candidateTestBlueprint", input.id, {
      lock: true,
    });
    version(r, input.expectedVersion);
    if (
      r.status !== "DRAFT" ||
      !r.approvedByHrId ||
      !r.approvedByHiringManagerId
    )
      fail("Both independent HR and hiring manager approvals are required");
    validatePool(
      r,
      await withPeriodExposure(tx, env, await tx.candidateTestItem.findMany({
        where: {tenantId:env.tenantId,status:"PUBLISHED",jobFamily:r.jobFamily,language:r.language},
      })),
    );
    return tx.candidateTestBlueprint.update({
      where: { id: r.id },
      data: { status: "PUBLISHED", revision: { increment: 1 } },
    });
  });
export const blueprintLink = (input) =>
  run(permission("publish"), async (tx, env) => {
    const r = await load(tx, env, "candidateTestBlueprint", input.blueprintId);
    if (r.status !== "PUBLISHED") fail("Publish the blueprint first");
    const scopeId = input.scopeId.trim();
    if (input.scopeType === "REQUISITION" && !/^[1-9]\d*$/.test(scopeId))
      fail("Choose a requisition");
    if (input.scopeType === "JOB_FAMILY" && scopeId !== r.jobFamily)
      fail("Assignment must match the blueprint job family");
    if (input.scopeType === "JOB_FAMILY_GRADE") {
      const split = scopeId.lastIndexOf(":");
      const gradeId = Number(scopeId.slice(split + 1));
      if (
        split < 1 ||
        scopeId.slice(0, split) !== r.jobFamily ||
        !Number.isSafeInteger(gradeId) ||
        !(await tx.gradeLevel.findFirst({
          where: { id: gradeId, tenantId: env.tenantId },
        }))
      )
        fail("Choose a grade in this company and the blueprint job family");
    }
    input = { ...input, scopeId };
    if (
      input.scopeType === "REQUISITION" &&
      !(await tx.jobRequisition.findFirst({
        where: { tenantId: env.tenantId, id: Number(input.scopeId) },
      }))
    )
      fail("Requisition not found", 404);
    await tx.candidateTestBlueprintLink.updateMany({
      where: {
        tenantId: env.tenantId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        isActive: true,
      },
      data: { isActive: false },
    });
    return tx.candidateTestBlueprintLink.create({
      data: { ...input, tenantId: env.tenantId },
    });
  });
export async function resolveBlueprint(tx, tenantId, requisition) {
  const family =
    requisition.jobContent?.jobFamily ?? String(requisition.positionId ?? "");
  for (const [scopeType, scopeId] of [
    ["REQUISITION", String(requisition.id)],
    ["JOB_FAMILY_GRADE", family + ":" + requisition.gradeLevelId],
    ["JOB_FAMILY", family],
  ]) {
    const link = await tx.candidateTestBlueprintLink.findFirst({
      where: { tenantId, scopeType, scopeId, isActive: true },
    });
    if (link) {
      const r = await tx.candidateTestBlueprint.findFirst({
        where: { tenantId, id: link.blueprintId, status: "PUBLISHED" },
      });
      if (r) return r;
    }
  }
  return null;
}
export const blueprintResolve = (input) =>
  run(permission("read"), async (tx, env) => {
    const r = await tx.jobRequisition.findFirst({
      where: { tenantId: env.tenantId, id: input.requisitionId },
    });
    if (!r) fail("Requisition not found", 404);
    return { blueprint: await resolveBlueprint(tx, env.tenantId, r) };
  });
export const blueprintPreview = (input) =>
  run(permission("read"), async (tx, env) => {
    const r = await load(tx, env, "candidateTestBlueprint", input.id);
    const items = await tx.candidateTestItem.findMany({
      where: {
        tenantId: env.tenantId,
        status: "PUBLISHED",
        jobFamily: r.jobFamily,
        language: r.language,
      },
    });
    try {
      validatePool(r, await withPeriodExposure(tx, env, items));
      return {
        eligible: true,
        sectionCounts: r.sections.map((s) => ({
          key: s.key,
          pool: items.filter((i) => i.competencyKey === s.competencyKey).length,
          draw: s.itemCount,
        })),
      };
    } catch (e) {
      return { eligible: false, reason: e.message };
    }
  });
export async function aiDraft(input, form = false) {
  return run(permission("create"), async (tx, env) => {
    if (!isRecruitmentFlagEnabled("ai")) fail("AI drafting is disabled", 503);
    const r = await tx.jobRequisition.findFirst({
      where: { tenantId: env.tenantId, id: input.requisitionId },
    });
    if (!r) fail("Requisition not found", 404);
    const res = await runAiTask({
      promptKey: form
        ? "hr.interview.form.draft.v1"
        : "hr.assessment.item.draft.v1",
      type: form ? "hr.interview-form-draft" : "hr.assessment-item-draft",
      tenantId: env.tenantId,
      input: { jobContent: r.jobContent, requirements: r.requirements },
    });
    if (res.status !== "ok")
      fail("AI drafting is unavailable; write a draft manually", 503);
    if (form)
      return {
        draft: EvaluationForm.parse(res.output?.result),
        aiDrafted: true,
        requiresHumanReview: true,
      };
    const item = TestItem.parse(res.output?.result);
    return saveItem(tx, env, item, { aiDrafted: true });
  });
}
