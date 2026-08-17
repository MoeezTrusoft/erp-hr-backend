// tests/unit/middlewares/prisma-transient-errors.test.js
//
// [HR-PRISMA-TRANSIENT-01] Infrastructure failures were reported as client errors.
//
// Every Prisma code outside {P2002, P2003, P2025, P2014} fell into one branch:
//
//     } else if (prismaCode.startsWith('P')) {
//         message = 'Invalid database operation';
//     }
//     ... code: defaultCodeForStatus(httpStatus)   // httpStatus still 400
//
// so a pool timeout and an unreachable database both surfaced as HTTP 400
// "Invalid database operation" with the actual Prisma code DISCARDED. Two
// consequences, both observed:
//   * the FE saw an intermittent "Invalid database operation" on Payroll Setup
//     page load which cleared on reload, and nobody could tell what it was —
//     the one diagnostic, the code, had been thrown away;
//   * a 400 tells the caller their request was malformed and is retried by
//     nothing, when the correct answer is "retry, the database was busy".
//
// P2024 is "Timed out fetching a new connection from the pool", the expected
// shape of a burst of parallel KPI reads against the pool cap.
//
// ERR-3 is unchanged: the raw Prisma message and meta still never leave the
// service. Only the code — which is not sensitive — is surfaced.
import { describe, it, expect } from '@jest/globals';

import { normalizeError } from '../../../src/middlewares/error.middleware.js';

const prismaError = (code) => {
    const err = new Error('raw prisma detail that must never be returned');
    err.name = 'PrismaClientKnownRequestError';
    err.code = code;
    return err;
};

describe('HR-PRISMA-TRANSIENT-01 transient Prisma failures are 503, not 400', () => {
    it.each([
        ['P2024'],
        ['P1001'],
        ['P1002'],
        ['P1017'],
        ['P2028'],
    ])('%s maps to 503 and keeps the code', (code) => {
        const out = normalizeError(prismaError(code));

        expect(out.httpStatus).toBe(503);
        expect(out.code).toBe(code);
        // The caller must be told this is worth retrying.
        expect(out.message).toMatch(/retry/i);
        // ERR-3: the raw Prisma text never escapes.
        expect(out.message).not.toMatch(/raw prisma detail/);
        expect(out.message).not.toBe('Invalid database operation');
    });

    it('an unrecognised P-code is still a 400, but now names itself', () => {
        // Unknown codes stay client errors — we do not guess that everything is
        // transient — but the code is preserved so the next one is diagnosable.
        const out = normalizeError(prismaError('P2099'));

        expect(out.httpStatus).toBe(400);
        expect(out.code).toBe('P2099');
        expect(out.message).toBe('Invalid database operation');
    });

    it('the four previously-mapped codes keep their status', () => {
        expect(normalizeError(prismaError('P2002')).httpStatus).toBe(409);
        expect(normalizeError(prismaError('P2025')).httpStatus).toBe(404);
        expect(normalizeError(prismaError('P2003')).httpStatus).toBe(400);
        expect(normalizeError(prismaError('P2014')).httpStatus).toBe(400);
    });
});
