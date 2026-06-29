// src/lib/c4Access.js — HR-01 / HR-10 (Roadmap T-P4.2)
//
// Deny-by-default access + audit for C4 (most-sensitive) reads. The roadmap
// requires that "every C4 read is auditable" (03-implementation-roadmap.md
// L208) and a deny-by-default read path (L226). Route-layer authz already
// gates the C4 surface (requirePermission('hr:payroll'), HR-03); this module
// adds the two things that finding-HR-01 owns on top of that gate:
//
//   1. assertC4ReadAccess — a reusable deny-by-default check, reusing the
//      EXISTING permission primitive (hasPermission / ACTION bitmask) so we do
//      not invent a parallel authorization system. It throws a 403-tagged
//      error if the caller lacks VIEW on the C4 resource.
//
//   2. auditC4Read — emits an auditable record of the C4 read through the
//      EXISTING audit sink (utils/logs.logAction → the Log table), tagged with
//      actor / target / action so a C4 access is traceable. The notes never
//      contain the decrypted value itself.
//
// Controllers call `guardAndAuditC4Read(req, { resource, action, target })`
// once, then perform the decrypted read through the normal (transparent)
// service path.
import { hasPermission } from '../mcp/utils/assertPermission.js';
import { logAction } from '../utils/logs.js';
import logger from './logger.js';

// The C4 resource key the payroll/HR C4 surface is keyed by (matches the route
// middleware's requirePermission('hr:payroll')).
export const C4_RESOURCE = 'hr:payroll';

/**
 * Deny-by-default check for a C4 read. Throws an error carrying `status: 403`
 * (the controller maps that to a 403 response) when the caller lacks the
 * permission. An EMPLOYEE reading their OWN data is allowed through when
 * `allowSelf` is set — the controller still enforces id-ownership, exactly as
 * the route middleware does.
 *
 * @returns {void}
 */
export const assertC4ReadAccess = (user, { resource = C4_RESOURCE, allowSelf = false } = {}) => {
    if (hasPermission(user?.permissions, resource, 'VIEW')) return;
    if (allowSelf && user?.role === 'EMPLOYEE') return; // controller enforces ownership
    throw Object.assign(
        new Error(`HR-1010 forbidden: missing C4 read permission ${resource}:VIEW`),
        { status: 403, code: 'HR-1010' },
    );
};

/**
 * Emit an auditable record of a C4 read. Best-effort: a failure to write the
 * audit row is logged but never throws (the read itself already succeeded /
 * was authorized). The notes describe WHAT was read (resource + target id),
 * never the decrypted value.
 */
export const auditC4Read = async (user, { resource = C4_RESOURCE, action = 'C4_READ', target } = {}) => {
    const actorId = user?.employeeId ?? user?.userId ?? null;
    try {
        await logAction({
            employeeId: actorId,
            actionById: actorId,
            type: 'C4Read',
            actionType: action,
            module: resource,
            result: 'SUCCESS',
            notes: `C4 read: ${resource}${target != null ? ` target=${target}` : ''}`,
        });
    } catch (err) {
        // logAction already swallows its own errors, but guard anyway so an
        // audit hiccup can never break a permitted read.
        logger.error({ err }, 'HR-1011 C4 read audit failed');
    }
};

/**
 * Convenience: enforce the deny-by-default gate THEN emit the audit record.
 * Controllers call this immediately before performing the decrypted C4 read.
 * Throws (403) if access is denied — in which case NO audit-success row is
 * written (the read never happens).
 */
export const guardAndAuditC4Read = async (
    user,
    { resource = C4_RESOURCE, action = 'C4_READ', target, allowSelf = false } = {},
) => {
    assertC4ReadAccess(user, { resource, allowSelf });
    await auditC4Read(user, { resource, action, target });
};

export default { C4_RESOURCE, assertC4ReadAccess, auditC4Read, guardAndAuditC4Read };
