// tests/helpers/internal-gateway.js
//
// Gateway-style header fixture for supertest-driven tests.
//
// In production, browser requests reach this service through the API
// gateway, which injects:
//
//   * `x-internal-secret`  -- the shared secret the /api gate matches
//   * `x-user-id`          -- numeric user id (decoded by attachHrContext)
//   * `x-user-email`       -- optional contact for audit trails
//   * `x-employee-id`      -- numeric employee id, when available
//   * `x-tenant-id`        -- numeric tenant scope
//   * `x-user-roles`       -- JSON-encoded array of role strings
//   * `x-user-permissions` -- JSON-encoded array of permission strings
//   * `x-is-admin`         -- the string "true" or "false"
//
// Tests that drive the real Express app via supertest must mirror that
// shape, otherwise they get a misleading 403 (gate) or 401 (route-level
// requireHrUser) and the failure points at the wrong place.
//
// This helper centralises that knowledge so individual suites don't:
//
//   * hard-code the secret string ("test-secret") and drift away from
//     whatever the env actually has,
//   * forget the JSON-encoding rule for roles/permissions,
//   * misspell `x-is-admin`'s "true"/"false" string contract,
//   * leak the secret into snapshots, log lines, or error messages.
//
// Usage:
//
//   import { gatewayHeaders } from '../helpers/internal-gateway.js';
//
//   const res = await request(app)
//     .get('/api/employees/me')
//     .set(gatewayHeaders({
//       user: { id: 7, roles: ['HR_ADMIN'], tenantId: 1 },
//     }));
//
// The secret is read from process.env on every call -- never cached,
// never echoed -- so per-test mutation of INTERNAL_SERVICE_SECRET is
// honoured and there is no stale-singleton trap.

const requireSecret = () => {
    const secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!secret) {
        // Deliberately does NOT echo the env var's value: even though
        // the assertion is that it is empty, attaching the value to
        // the error message would normalise the pattern of including
        // secrets in error text elsewhere.
        throw new Error(
            'internal-gateway fixture: INTERNAL_SERVICE_SECRET must be set ' +
            'on process.env before building gateway headers (set it in ' +
            'tests/setup.js or via beforeEach in the suite that needs it)'
        );
    }
    return secret;
};

/**
 * Returns the minimum header set the /api internal-secret gate needs.
 * Any caller-supplied `overrides` win over the defaults so an
 * individual test can simulate a stale-secret regression without
 * giving up the helper.
 */
export const internalServiceHeaders = (overrides = {}) => ({
    'x-internal-secret': requireSecret(),
    ...overrides,
});

/**
 * Returns the gateway-style header set, including any `x-user-*`
 * fields derived from `user`. Headers in `overrides` win, so a test
 * can override a single field (e.g. send a malformed `x-user-roles`)
 * without re-implementing the whole shape.
 *
 * `user` shape (all fields optional):
 *   id          -> 'x-user-id' (stringified)
 *   email       -> 'x-user-email'
 *   employeeId  -> 'x-employee-id' (stringified)
 *   tenantId    -> 'x-tenant-id' (stringified)
 *   roles       -> 'x-user-roles' (JSON.stringify'd array)
 *   permissions -> 'x-user-permissions' (JSON.stringify'd array)
 *   isAdmin     -> 'x-is-admin' (the literal string 'true' or 'false')
 */
export const gatewayHeaders = ({ user, headers: overrides } = {}) => {
    const headers = { 'x-internal-secret': requireSecret() };

    if (user) {
        if (user.id !== undefined && user.id !== null) {
            headers['x-user-id'] = String(user.id);
        }
        if (user.email) {
            headers['x-user-email'] = user.email;
        }
        if (user.employeeId !== undefined && user.employeeId !== null) {
            headers['x-employee-id'] = String(user.employeeId);
        }
        if (user.tenantId !== undefined && user.tenantId !== null) {
            headers['x-tenant-id'] = String(user.tenantId);
        }
        if (user.roles !== undefined) {
            headers['x-user-roles'] = JSON.stringify(user.roles);
        }
        if (user.permissions !== undefined) {
            headers['x-user-permissions'] = JSON.stringify(user.permissions);
        }
        if (user.isAdmin !== undefined) {
            headers['x-is-admin'] = user.isAdmin ? 'true' : 'false';
        }
    }

    return { ...headers, ...overrides };
};
