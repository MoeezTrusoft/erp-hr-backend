// tests/unit/services/dam.rbac.department.test.js
// — B1-HR-DAM-RBAC-DEPARTMENT-SERVICE-JWT.
//
// Proves that DAM calls made through the dam.rbac.department.js re-export
// path emit the same dual headers as the underlying dam.media.service.js:
//   1. X-Internal-Secret            (legacy, must not be removed)
//   2. X-Service-Authorization: Bearer <jwt>  (service JWT)
//
// dam.rbac.department.js re-exports damRequest from dam.media.service.js
// (line 40: `export const damRequest = mediaDamRequest`), so the header
// injection already flows through. This test file closes the audit gap
// by providing explicit evidence via the re-export import path.

import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';

// Mock axios so no real HTTP is issued.
let mockRequest;
jest.unstable_mockModule('axios', () => {
    mockRequest = jest.fn().mockResolvedValue({ data: { ok: true, items: [] } });
    return {
        default: {
            create: () => ({ request: mockRequest }),
        },
    };
});

const FIXED_SECRET = 'test-service-secret-do-not-use-in-prod';
const FIXED_INTERNAL = 'legacy-internal-secret-value';

const ORIGINAL = {
    SERVICE_JWT_SECRET: process.env.SERVICE_JWT_SECRET,
    SERVICE_JWT_AUDIENCE: process.env.SERVICE_JWT_AUDIENCE,
    SERVICE_JWT_SELF_ISSUER: process.env.SERVICE_JWT_SELF_ISSUER,
    INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET,
};

describe('dam.rbac.department.js DAM re-export headers [B1-HR-DAM-RBAC-DEPARTMENT-SERVICE-JWT]', () => {
    let damRequest;

    beforeEach(async () => {
        process.env.SERVICE_JWT_SECRET = FIXED_SECRET;
        process.env.SERVICE_JWT_AUDIENCE = 'internal';
        process.env.INTERNAL_SERVICE_SECRET = FIXED_INTERNAL;
        delete process.env.SERVICE_JWT_SELF_ISSUER;

        // Import through the dam.rbac.department path — the one the audit flagged.
        const mod = await import('../../../src/services/dam.rbac.department.js');
        damRequest = mod.damRequest;
        mockRequest.mockClear();
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(ORIGINAL)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    test('damRequest (re-exported) emits X-Internal-Secret (legacy preserved)', async () => {
        await damRequest('/assets/100', 'GET');
        expect(mockRequest).toHaveBeenCalledTimes(1);
        const { headers } = mockRequest.mock.calls[0][0];
        expect(headers['X-Internal-Secret']).toBe(FIXED_INTERNAL);
    });

    test('damRequest (re-exported) emits X-Service-Authorization with Bearer prefix', async () => {
        await damRequest('/assets/100', 'GET');
        const { headers } = mockRequest.mock.calls[0][0];
        expect(headers['X-Service-Authorization']).toMatch(/^Bearer .+\..+\..+$/);
    });

    test('both headers are present simultaneously on the same call', async () => {
        await damRequest('/assets/200', 'POST', { data: 1 });
        const { headers } = mockRequest.mock.calls[0][0];
        expect(headers).toHaveProperty('X-Internal-Secret', FIXED_INTERNAL);
        expect(headers).toHaveProperty('X-Service-Authorization');
        expect(headers['X-Service-Authorization']).toMatch(/^Bearer /);
    });

    test('X-Service-Authorization omitted when SERVICE_JWT_SECRET is unset (graceful degradation)', async () => {
        delete process.env.SERVICE_JWT_SECRET;
        await damRequest('/assets/300', 'GET');
        const { headers } = mockRequest.mock.calls[0][0];
        expect(headers['X-Internal-Secret']).toBe(FIXED_INTERNAL);
        expect(headers['X-Service-Authorization']).toBeUndefined();
    });

    test('re-exported damRequest is the same function reference as dam.media.service.damRequest', async () => {
        const media = await import('../../../src/services/dam.media.service.js');
        const rbac = await import('../../../src/services/dam.rbac.department.js');
        expect(rbac.damRequest).toBe(media.damRequest);
    });
});

// --- HR-SELF-CALL-SERVICE-JWT: hrRequest dead-code evidence ---
// `hrRequest` is exported by dam.rbac.department.js but never imported
// anywhere in the codebase (verified via repo-wide grep for "hrRequest").
// This describe block documents that finding so future audits can skip it.
describe('dam.rbac.department.js hrRequest dead-code status [HR-SELF-CALL-SERVICE-JWT]', () => {
    test('hrRequest is exported but is not imported anywhere in src/', async () => {
        const { execSync } = await import('child_process');
        // grep the entire src/ tree for any import/require of hrRequest,
        // excluding the definition file itself.
        const result = execSync(
            'grep -rn "hrRequest" src/ --include="*.js" || true',
            { cwd: process.cwd(), encoding: 'utf8' },
        ).trim();

        // The only hit should be the export definition line in dam.rbac.department.js.
        const lines = result.split('\n').filter(Boolean);
        const importers = lines.filter(
            (l) => !l.includes('dam.rbac.department.js'),
        );
        expect(importers).toHaveLength(0);
    });

    test('hrRequest is a callable function (guards against silent removal)', async () => {
        const mod = await import('../../../src/services/dam.rbac.department.js');
        expect(typeof mod.hrRequest).toBe('function');
    });
});
