// tests/unit/helpers/internal-gateway.test.js
import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import {
    internalServiceHeaders,
    gatewayHeaders,
} from '../../helpers/internal-gateway.js';

const ORIGINAL_SECRET = process.env.INTERNAL_SERVICE_SECRET;

describe('tests/helpers/internal-gateway.js', () => {
    beforeEach(() => {
        delete process.env.INTERNAL_SERVICE_SECRET;
    });

    afterAll(() => {
        if (ORIGINAL_SECRET === undefined) {
            delete process.env.INTERNAL_SERVICE_SECRET;
        } else {
            process.env.INTERNAL_SERVICE_SECRET = ORIGINAL_SECRET;
        }
    });

    describe('internalServiceHeaders()', () => {
        test('emits only x-internal-secret when no overrides are supplied', () => {
            process.env.INTERNAL_SERVICE_SECRET = 'env-secret';

            const headers = internalServiceHeaders();

            expect(headers).toEqual({ 'x-internal-secret': 'env-secret' });
        });

        test('caller overrides win, including the secret itself (for regression tests)', () => {
            process.env.INTERNAL_SERVICE_SECRET = 'env-secret';

            const headers = internalServiceHeaders({
                'x-internal-secret': 'stale-secret',
                'x-extra': 'allowed',
            });

            expect(headers['x-internal-secret']).toBe('stale-secret');
            expect(headers['x-extra']).toBe('allowed');
        });

        test('throws with a non-leaking message when the env var is unset', () => {
            // Sanity check: the var is genuinely absent thanks to beforeEach.
            expect(process.env.INTERNAL_SERVICE_SECRET).toBeUndefined();

            expect(() => internalServiceHeaders()).toThrow(
                /INTERNAL_SERVICE_SECRET must be set/
            );
        });

        test('re-reads the env var on each call rather than caching at import time', () => {
            process.env.INTERNAL_SERVICE_SECRET = 'first';
            expect(internalServiceHeaders()['x-internal-secret']).toBe('first');

            process.env.INTERNAL_SERVICE_SECRET = 'second';
            expect(internalServiceHeaders()['x-internal-secret']).toBe('second');
        });
    });

    describe('gatewayHeaders()', () => {
        beforeEach(() => {
            process.env.INTERNAL_SERVICE_SECRET = 'env-secret';
        });

        test('returns only the secret when no user/overrides are supplied', () => {
            expect(gatewayHeaders()).toEqual({ 'x-internal-secret': 'env-secret' });
        });

        test('composes the full x-user-* shape from a user object', () => {
            const headers = gatewayHeaders({
                user: {
                    id: 7,
                    email: 'sara@example.test',
                    employeeId: 42,
                    tenantId: 1,
                    roles: ['HR_ADMIN', 'MANAGER'],
                    permissions: ['employee:read'],
                    isAdmin: true,
                },
            });

            expect(headers).toEqual({
                'x-internal-secret': 'env-secret',
                'x-user-id': '7',
                'x-user-email': 'sara@example.test',
                'x-employee-id': '42',
                'x-tenant-id': '1',
                'x-user-roles': '["HR_ADMIN","MANAGER"]',
                'x-user-permissions': '["employee:read"]',
                'x-is-admin': 'true',
            });
        });

        test('coerces numeric ids and tenant to strings (HTTP headers must be strings)', () => {
            const headers = gatewayHeaders({
                user: { id: 0, employeeId: 0, tenantId: 0 },
            });

            // 0 must still be emitted -- it is a valid id, not "no id given".
            expect(headers['x-user-id']).toBe('0');
            expect(headers['x-employee-id']).toBe('0');
            expect(headers['x-tenant-id']).toBe('0');
        });

        test('emits x-is-admin as the literal "false" when isAdmin is false', () => {
            // hrContext.middleware.js compares against the literal string
            // "true", so any non-"true" value reads as not-admin. We pin
            // "false" explicitly so the wire shape is unambiguous.
            const headers = gatewayHeaders({ user: { id: 1, isAdmin: false } });

            expect(headers['x-is-admin']).toBe('false');
        });

        test('omits x-user-* keys that the caller did not supply', () => {
            const headers = gatewayHeaders({ user: { id: 9 } });

            expect(headers).toEqual({
                'x-internal-secret': 'env-secret',
                'x-user-id': '9',
            });
            expect(headers).not.toHaveProperty('x-user-email');
            expect(headers).not.toHaveProperty('x-user-roles');
            expect(headers).not.toHaveProperty('x-is-admin');
        });

        test('JSON-encodes an empty roles array rather than dropping the header', () => {
            // Distinguishing "explicit empty array" from "not supplied"
            // matters for tests that exercise the "user has no roles"
            // branch of attachHrContext.
            const headers = gatewayHeaders({ user: { id: 1, roles: [] } });

            expect(headers['x-user-roles']).toBe('[]');
        });

        test('headers overrides win over the secret and over derived x-user-* fields', () => {
            const headers = gatewayHeaders({
                user: { id: 1, roles: ['HR_ADMIN'] },
                headers: {
                    'x-internal-secret': 'override-secret',
                    'x-user-roles': 'not-even-json',
                    'x-extra': 'still-here',
                },
            });

            expect(headers['x-internal-secret']).toBe('override-secret');
            expect(headers['x-user-roles']).toBe('not-even-json');
            expect(headers['x-extra']).toBe('still-here');
        });

        test('throws the same non-leaking message as internalServiceHeaders when env is unset', () => {
            delete process.env.INTERNAL_SERVICE_SECRET;

            expect(() => gatewayHeaders({ user: { id: 1 } })).toThrow(
                /INTERNAL_SERVICE_SECRET must be set/
            );
        });

        test('error message does not echo the supplied user payload or any secret', () => {
            delete process.env.INTERNAL_SERVICE_SECRET;

            // Worst-case: a test sets the secret to something secret-looking,
            // then clears it before calling the helper. The thrown error
            // must not surface that prior value or anything from the user
            // payload that could end up in CI logs.
            const previousSecret = 'super-secret-do-not-log';
            process.env.INTERNAL_SERVICE_SECRET = previousSecret;
            delete process.env.INTERNAL_SERVICE_SECRET;

            try {
                gatewayHeaders({
                    user: { id: 1, email: 'leaky@example.test' },
                });
                throw new Error('expected gatewayHeaders to throw');
            } catch (err) {
                expect(err.message).not.toContain(previousSecret);
                expect(err.message).not.toContain('leaky@example.test');
            }
        });
    });
});
