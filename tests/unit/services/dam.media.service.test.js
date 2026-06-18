// tests/unit/services/dam.media.service.test.js — A-HR-EMIT-SERVICE-JWT-DAM.
//
// Proves that every outbound HR → DAM call emits BOTH:
//   1. X-Internal-Secret  (legacy, must not be removed)
//   2. X-Service-Authorization: Bearer <jwt>  (new service JWT)
//
// The axios instance is mocked so no real HTTP is needed.
import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';

// Capture axios.create so we can intercept .request()
let mockRequest;
jest.unstable_mockModule('axios', () => {
    mockRequest = jest.fn().mockResolvedValue({ data: { ok: true } });
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

describe('dam.media.service outbound headers [A-HR-EMIT-SERVICE-JWT-DAM]', () => {
    let damRequest, uploadFileToDAM;

    beforeEach(async () => {
        process.env.SERVICE_JWT_SECRET = FIXED_SECRET;
        process.env.SERVICE_JWT_AUDIENCE = 'internal';
        process.env.INTERNAL_SERVICE_SECRET = FIXED_INTERNAL;
        delete process.env.SERVICE_JWT_SELF_ISSUER;

        // Re-import so env changes and the mock are picked up.
        const mod = await import('../../../src/services/dam.media.service.js');
        damRequest = mod.damRequest;
        uploadFileToDAM = mod.uploadFileToDAM;
        mockRequest.mockClear();
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(ORIGINAL)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    test('damRequest emits X-Internal-Secret header (legacy preserved)', async () => {
        await damRequest('/assets/123', 'GET');
        expect(mockRequest).toHaveBeenCalledTimes(1);
        const { headers } = mockRequest.mock.calls[0][0];
        expect(headers['X-Internal-Secret']).toBe(FIXED_INTERNAL);
    });

    test('damRequest emits X-Service-Authorization header with Bearer prefix', async () => {
        await damRequest('/assets/123', 'GET');
        const { headers } = mockRequest.mock.calls[0][0];
        expect(headers['X-Service-Authorization']).toMatch(/^Bearer .+\..+\..+$/);
    });

    test('both headers are present simultaneously on the same call', async () => {
        await damRequest('/assets/456', 'POST', { foo: 1 });
        const { headers } = mockRequest.mock.calls[0][0];
        expect(headers).toHaveProperty('X-Internal-Secret', FIXED_INTERNAL);
        expect(headers).toHaveProperty('X-Service-Authorization');
        expect(headers['X-Service-Authorization']).toMatch(/^Bearer /);
    });

    test('X-Service-Authorization is omitted when SERVICE_JWT_SECRET is unset (graceful degradation)', async () => {
        delete process.env.SERVICE_JWT_SECRET;
        // Need to re-import after env change, but signServiceJwt reads env
        // at call time so the existing import is fine.
        await damRequest('/assets/789', 'GET');
        const { headers } = mockRequest.mock.calls[0][0];
        expect(headers['X-Internal-Secret']).toBe(FIXED_INTERNAL);
        expect(headers['X-Service-Authorization']).toBeUndefined();
    });

    test('caller-supplied headers are preserved alongside auth headers', async () => {
        await damRequest('/assets/upload', 'POST', {}, { 'Content-Type': 'multipart/form-data' });
        const { headers } = mockRequest.mock.calls[0][0];
        expect(headers['Content-Type']).toBe('multipart/form-data');
        expect(headers['X-Internal-Secret']).toBe(FIXED_INTERNAL);
        expect(headers['X-Service-Authorization']).toMatch(/^Bearer /);
    });
});
