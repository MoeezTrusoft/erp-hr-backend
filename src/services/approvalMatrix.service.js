// Approval matrix store: one DRAFT and one PUBLISHED route per company and kind
// (ATTENDANCE, PAYROLL). Publishing supersedes the previous route; requests already submitted keep
// the route they sealed (services/approval/service.js), so a change only affects new submissions.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { assertKind, parseLevels } from "../lib/approvalMatrix.js";
import { logAction } from "../utils/logs.js";

const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const INACTIVE = /inactive|terminated|exited|separated/i;
const person = (e) => ({
  id: e.id,
  code: e.employee_code,
  name: [e.first_name, e.last_name].filter(Boolean).join(" "),
  active: !INACTIVE.test(`${e.status} ${e.employement_status}`),
});

async function directory(tx, tenantId, levels) {
  const ids = [...new Set(levels.flatMap((l) => l.approverIds || []))];
  if (!ids.length) return new Map();
  const rows = await tx.employee.findMany({ where: { tenant_id: tenantId, id: { in: ids } } });
  return new Map(rows.map((e) => [e.id, person(e)]));
}

async function assertApprovers(tx, tenantId, levels) {
  const people = await directory(tx, tenantId, levels);
  levels.forEach((l, i) =>
    l.approverIds.forEach((id) => {
      const p = people.get(id);
      if (!p) throw fail(`Level ${i + 1} (${l.name}): employee ${id} is not in this company`);
      if (!p.active) throw fail(`Level ${i + 1} (${l.name}): ${p.name || p.code} is not active`);
      if (!p.code) throw fail(`Level ${i + 1} (${l.name}): ${p.name} has no employee code`);
    }),
  );
  return people;
}

const present = (row, people) =>
  row && {
    id: row.id,
    kind: row.kind,
    version: row.version,
    status: row.status,
    note: row.note,
    levels: row.levels.map((l) => ({
      ...l,
      approvers: (l.approverIds || []).map((id) => people.get(id) ?? { id, code: null, name: "Unknown employee", active: false }),
    })),
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };

export async function getApprovalMatrix({ tenantId, kind }) {
  assertKind(kind);
  return tenantTransaction(prisma, async (tx) => {
    const rows = await tx.approvalMatrix.findMany({
      where: { tenantId, kind },
      orderBy: { version: "desc" },
      take: 12,
    });
    const people = await directory(tx, tenantId, rows.flatMap((r) => r.levels));
    const published = rows.find((r) => r.status === "PUBLISHED");
    const draft = rows.find((r) => r.status === "DRAFT");
    return {
      kind,
      published: present(published, people),
      draft: present(draft, people),
      history: rows.filter((r) => r.status === "SUPERSEDED").map((r) => present(r, people)),
      // Until a route is published the four fixed stages apply.
      usingFixedStages: !published,
    };
  }, { tenantId });
}

export async function saveApprovalMatrixDraft({ tenantId, kind, levels: raw, note, actorId }) {
  const levels = parseLevels(kind, raw);
  const out = await tenantTransaction(prisma, async (tx) => {
    await assertApprovers(tx, tenantId, levels);
    const draft = await tx.approvalMatrix.findFirst({ where: { tenantId, kind, status: "DRAFT" } });
    if (draft)
      return tx.approvalMatrix.update({ where: { id: draft.id }, data: { levels, note: note ?? null } });
    const latest = await tx.approvalMatrix.findFirst({ where: { tenantId, kind }, orderBy: { version: "desc" } });
    return tx.approvalMatrix.create({
      data: { tenantId, kind, version: (latest?.version ?? 0) + 1, status: "DRAFT", levels, note: note ?? null, createdById: String(actorId) },
    });
  }, { tenantId });
  await logAction({ type: "UPDATE", module: "ApprovalMatrix", result: "SUCCESS", tenantId, notes: `${kind} approval matrix draft v${out.version} saved by ${actorId}` }).catch(() => {});
  return getApprovalMatrix({ tenantId, kind });
}

export async function discardApprovalMatrixDraft({ tenantId, kind, actorId }) {
  assertKind(kind);
  await tenantTransaction(prisma, async (tx) => {
    const draft = await tx.approvalMatrix.findFirst({ where: { tenantId, kind, status: "DRAFT" } });
    if (!draft) throw fail("There is no draft to discard", 404);
    await tx.approvalMatrix.delete({ where: { id: draft.id } });
  }, { tenantId });
  await logAction({ type: "DELETE", module: "ApprovalMatrix", result: "SUCCESS", tenantId, notes: `${kind} approval matrix draft discarded by ${actorId}` }).catch(() => {});
  return getApprovalMatrix({ tenantId, kind });
}

export async function publishApprovalMatrix({ tenantId, kind, reason, actorId }) {
  assertKind(kind);
  if (!reason?.trim()) throw fail("A publication reason is required");
  const version = await tenantTransaction(prisma, async (tx) => {
    const draft = await tx.approvalMatrix.findFirst({ where: { tenantId, kind, status: "DRAFT" } });
    if (!draft) throw fail("Save a draft before publishing", 409);
    const levels = parseLevels(kind, draft.levels);
    await assertApprovers(tx, tenantId, levels);
    await tx.approvalMatrix.updateMany({ where: { tenantId, kind, status: "PUBLISHED" }, data: { status: "SUPERSEDED" } });
    await tx.approvalMatrix.update({
      where: { id: draft.id },
      data: { status: "PUBLISHED", publishedAt: new Date(), publishedById: String(actorId), note: reason.trim() },
    });
    return draft.version;
  }, { tenantId });
  await logAction({ type: "UPDATE", module: "ApprovalMatrix", result: "SUCCESS", tenantId, notes: `${kind} approval matrix v${version} published by ${actorId}: ${reason.trim()}` }).catch(() => {});
  return getApprovalMatrix({ tenantId, kind });
}

// Back to the four fixed stages (the safety valve when a route is misconfigured).
export async function retireApprovalMatrix({ tenantId, kind, reason, actorId }) {
  assertKind(kind);
  if (!reason?.trim()) throw fail("A reason is required");
  await tenantTransaction(prisma, async (tx) => {
    const done = await tx.approvalMatrix.updateMany({ where: { tenantId, kind, status: "PUBLISHED" }, data: { status: "SUPERSEDED" } });
    if (!done.count) throw fail("No approval matrix is published", 409);
  }, { tenantId });
  await logAction({ type: "UPDATE", module: "ApprovalMatrix", result: "SUCCESS", tenantId, notes: `${kind} approval matrix retired by ${actorId}: ${reason.trim()}` }).catch(() => {});
  return getApprovalMatrix({ tenantId, kind });
}

// The route the engine seals into a new submission (null = fixed stages).
export async function loadPublishedMatrix(tx, tenantId, kind) {
  const row = await tx.approvalMatrix.findFirst({ where: { tenantId, kind, status: "PUBLISHED" } });
  return row ? { version: row.version, levels: parseLevels(kind, row.levels) } : null;
}
