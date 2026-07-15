// src/services/profileActions.service.js — HR Employee-Profile WRITE actions
// + Activity export.
//
// Area: document lifecycle actions on the EmployeeMedia model (verify / mark
// missing / remove) and a CSV|PDF export of the audit/activity stream.
//
// TENANCY (T-P2.x / C.2): EmployeeMedia carries the verified tenant under the
// camelCase `tenantId` column (RBAC Company.uuid from the signed service-JWT).
// Every query here is tenant-scoped fail-closed — a null/missing tenant matches
// ONLY null-tenant rows and can never widen across tenants. The document-action
// helpers scope by { id, tenantId }; the write only lands when the row is both
// the requested id AND in the caller's tenant, so a cross-tenant id 404s.
//
// The MCP tool caller MUST assertPermission('hr:employee', PUT|DELETE|GET)
// before invoking these functions (see profileActionTools.js).

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { exportRows } from '../lib/export.util.js';
import { listEmployeeActivity } from './employeeActivity.service.js';

const notFound = () =>
  Object.assign(new Error('Document not found'), { status: 404 });

const parseId = (value) => {
  const id = Number(value);
  if (!Number.isFinite(id)) throw Object.assign(new Error('Invalid document ID'), { status: 400 });
  return id;
};

// Tenant-scoped predicate for an EmployeeMedia row. `tenantId` folds in
// fail-closed exactly like the shared tenancy helpers (null matches null rows).
const scopedMediaWhere = (documentId, tenantId) => ({
  id: parseId(documentId),
  tenantId: tenantId ?? null,
});

/**
 * Set an EmployeeMedia row's status, tenant-scoped. Fail-closed: a missing or
 * cross-tenant document 404s before any write.
 * @param {string|number} documentId
 * @param {string|null}   tenantId
 * @param {string}        status
 * @returns {Promise<object>} the updated document
 */
async function setDocumentStatus(documentId, tenantId, status) {
  const where = scopedMediaWhere(documentId, tenantId);
  const existing = await prisma.employeeMedia.findFirst({ where, select: { id: true } });
  if (!existing) throw notFound();

  const updated = await prisma.employeeMedia.update({
    where: { id: existing.id },
    data: { status },
  });

  logger.debug({ documentId: existing.id, tenantId, status }, 'hr: setDocumentStatus');
  return updated;
}

/**
 * Mark a document verified.
 */
export async function markDocumentVerified(documentId, tenantId) {
  return setDocumentStatus(documentId, tenantId, 'verified');
}

/**
 * Mark a document missing.
 */
export async function markDocumentMissing(documentId, tenantId) {
  return setDocumentStatus(documentId, tenantId, 'missing');
}

/**
 * Hard-delete an EmployeeMedia row, tenant-scoped. EmployeeMedia has no
 * soft-delete column (only a free-form `status`), so removal is a hard delete
 * per spec. Fail-closed: a missing or cross-tenant document 404s.
 * @param {string|number} documentId
 * @param {string|null}   tenantId
 * @returns {Promise<{ success: true, id: number }>}
 */
export async function removeDocument(documentId, tenantId) {
  const where = scopedMediaWhere(documentId, tenantId);
  const existing = await prisma.employeeMedia.findFirst({ where, select: { id: true } });
  if (!existing) throw notFound();

  await prisma.employeeMedia.delete({ where: { id: existing.id } });

  logger.debug({ documentId: existing.id, tenantId }, 'hr: removeDocument');
  return { success: true, id: existing.id };
}

// ---------------------------------------------------------------------------
// Activity export
// ---------------------------------------------------------------------------

const ACTIVITY_EXPORT_COLUMNS = [
  { key: 'timestamp', header: 'Timestamp', value: (r) => (r.timestamp ? new Date(r.timestamp).toISOString() : '-') },
  { key: 'action', header: 'Action', value: (r) => r.action || '-' },
  { key: 'actor', header: 'Actor', value: (r) => r.actor ?? '-' },
  { key: 'target', header: 'Target', value: (r) => r.target ?? '-' },
  { key: 'details', header: 'Details', value: (r) => r.details ?? '-' },
];

const inRange = (created, from, to) => {
  if (!created) return true;
  const t = new Date(created).getTime();
  if (from) {
    const f = new Date(from).getTime();
    if (Number.isFinite(f) && t < f) return false;
  }
  if (to) {
    const e = new Date(to).getTime();
    if (Number.isFinite(e) && t > e) return false;
  }
  return true;
};

// Shape an item from listEmployeeActivity into an export row. That function
// returns { id, timestamp, action, module, result, notes, ip }. There is no
// actor/target on that shape, so Actor falls back to the module and Target to
// the employee the export is scoped to; Details carries result + notes.
const activityExportRow = (item, employeeId) => ({
  timestamp: item.timestamp ?? null,
  action: item.action ?? item.module ?? 'SYSTEM',
  actor: item.actor ?? item.module ?? '-',
  target: item.target ?? (employeeId != null ? String(employeeId) : '-'),
  details: [item.result, item.notes].filter(Boolean).join(' — ') || '-',
});

// Tenant-wide activity slice (no employeeId). Reads the same Log source
// listEmployeeActivity uses, tenant-scoped fail-closed, and shapes rows the
// same way so the two code paths serialize identically.
const TENANT_ACTIVITY_CAP = 5000;
async function listTenantActivity(tenantId) {
  const logs = await prisma.log.findMany({
    where: { tenantId: tenantId ?? null },
    orderBy: { created_at: 'desc' },
    take: TENANT_ACTIVITY_CAP,
    select: {
      id: true,
      created_at: true,
      type: true,
      action_type: true,
      module: true,
      result: true,
      notes: true,
      employeeId: true,
      actionById: true,
    },
  });
  return logs.map((log) => ({
    id: log.id,
    timestamp: log.created_at ?? null,
    action: log.action_type || log.type || 'SYSTEM',
    module: log.module ?? null,
    result: log.result ?? null,
    notes: log.notes ?? null,
    actor: log.actionById != null ? String(log.actionById) : null,
    target: log.employeeId != null ? String(log.employeeId) : null,
  }));
}

/**
 * Export HR audit/activity rows as CSV or PDF.
 *
 * When `employeeId` is supplied the rows come from the shared
 * listEmployeeActivity() (per-employee, tenant-scoped, fail-closed 404 on a
 * cross-tenant employee). Without it, a tenant-wide slice is exported.
 *
 * @param {object}        opts
 * @param {string|number} [opts.employeeId]
 * @param {"csv"|"pdf"}   opts.format
 * @param {string}        [opts.from]  ISO date lower bound (inclusive)
 * @param {string}        [opts.to]    ISO date upper bound (inclusive)
 * @param {string|null}   tenantId     verified RBAC Company.uuid
 * @returns {Promise<{ format, fileName, mimeType, count, base64 }>}
 */
export async function exportActivity({ employeeId, format = 'csv', from, to } = {}, tenantId) {
  let items;
  if (employeeId != null && employeeId !== '') {
    // Reuse the existing employee-activity path; pull a capped page.
    const result = await listEmployeeActivity(employeeId, tenantId, { page: 1, pageSize: 100 });
    items = (result?.items || []).map((it) => activityExportRow(it, employeeId));
  } else {
    const tenantRows = await listTenantActivity(tenantId);
    items = tenantRows.map((it) => activityExportRow(it, null));
  }

  const rows = items.filter((r) => inRange(r.timestamp, from, to));

  const stamp = new Date().toISOString().slice(0, 10);
  const scope = employeeId != null && employeeId !== '' ? `employee-${employeeId}` : 'all';

  const { mimeType, ext, buffer } = await exportRows(format, {
    title: 'HR Activity Log',
    subtitle: `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} (${scope}) — generated ${stamp}`,
    columns: ACTIVITY_EXPORT_COLUMNS,
    rows,
  });

  logger.debug({ employeeId, tenantId, format, count: rows.length }, 'hr: exportActivity');

  return {
    format,
    fileName: `hr-activity-${scope}-${stamp}.${ext}`,
    mimeType,
    count: rows.length,
    base64: buffer.toString('base64'),
  };
}
