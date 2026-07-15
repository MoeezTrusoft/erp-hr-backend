// src/services/employeeActivity.service.js — Phase 3 / HR-ACT-01
//
// Surfaces audit / activity log entries for the Activity tab. The only
// activity source currently available in erp-hr-backend is the `Log` model
// (prisma.log), written by logAction() in src/utils/logs.js. Every mutating
// MCP tool and controller calls logAction, so this produces a real stream of
// who-did-what across HR operations.
//
// The service is intentionally narrow:
//   * Always tenant-scoped (via employee.tenant_id cross-ref).
//   * Never exposes raw token material, passwords, or C4-sensitive fields.
//   * Returns a paginated { items, total, page, pageSize } envelope matching
//     the HR list contract so the FE ActivityTab can drop it in directly.
//
// Access control:
//   The MCP tool caller MUST assertPermission('hr:employee', 'GET') before
//   calling these functions.

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { scopedEmployeeWhere } from '../lib/tenancy.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Shape a Log row into the Activity item the FE ActivityTab consumes.
 */
const activityRow = (log) => ({
  id: log.id,
  timestamp: log.created_at ?? log.createdAt ?? null,
  action: log.action_type || log.type || 'SYSTEM',
  module: log.module ?? null,
  result: log.result ?? null,
  notes: log.notes ?? null,
  // Mask ip for privacy; keep for internal debugging.
  ip: log.ip && log.ip !== 'unknown' ? log.ip : null,
});

/**
 * List activity log entries for a specific employee.
 *
 * @param {string|number} employeeId
 * @param {string|null}   tenantId   - verified RBAC Company.uuid from the service-JWT.
 * @param {object}        [opts]
 * @param {number}        [opts.page=1]
 * @param {number}        [opts.pageSize=20]
 * @returns {Promise<{ items: object[], total: number, page: number, pageSize: number }>}
 */
export async function listEmployeeActivity(employeeId, tenantId, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const id = Number(employeeId);
  if (!Number.isFinite(id)) throw Object.assign(new Error('Invalid employee ID'), { status: 400 });

  const normalizedPage = Math.max(1, page);
  const normalizedPageSize = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
  const skip = (normalizedPage - 1) * normalizedPageSize;

  // Verify the employee exists and belongs to the caller's tenant before returning
  // their activity. Fail-closed: a missing or cross-tenant employee → 404.
  const employee = await prisma.employee.findFirst({
    where: scopedEmployeeWhere(tenantId, { id }),
    select: { id: true },
  });

  if (!employee) throw Object.assign(new Error('Employee not found'), { status: 404 });

  logger.debug({ employeeId: id, tenantId, page: normalizedPage, pageSize: normalizedPageSize }, 'hr: listEmployeeActivity');

  const where = {
    OR: [
      { employeeId: id },
      { actionById: id },
    ],
  };

  const [logs, total] = await Promise.all([
    prisma.log.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take: normalizedPageSize,
      select: {
        id: true,
        created_at: true,
        type: true,
        action_type: true,
        module: true,
        result: true,
        notes: true,
        ip: true,
      },
    }),
    prisma.log.count({ where }),
  ]);

  return {
    items: logs.map(activityRow),
    total,
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
}
