// HR-ATT-DEVICE-ENROLMENT-01 — one employee, several device ids over time.
//
// `Employee.biometric_id` holds a single string, so a person can only ever have
// one enrolment. Three real cases on production:
//
//   Afsha Khan (EMP159)   2    -> 306    September punches, unresolved TODAY
//   Samina     (EMP224)   3021 -> 3123   September punches, unresolved TODAY
//   Faizan Afaq(EMP178)   1    -> 500    July, history only
//
// The obvious fix — allow several ids per employee — is wrong, and the reason
// is the whole point of this model. Device ids get REUSED. If `2` is later
// issued to somebody else, a multi-value list would claim every historical
// punch under `2` for Afsha, including punches belonging to another person.
// Attendance would move silently between people, which is worse than the gap.
//
// So an enrolment is true FOR A PERIOD, and resolution matches the id that was
// current WHEN THE PUNCH HAPPENED — not the employee's current id.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TRUSOFT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const HOMENET = '8ff0533b-62f6-4be9-a78e-69adf49e00bc';

// Afsha moved 2 -> 306 on 1 September. `2` was then reissued to someone else in
// Homenet — the case a plain id list gets wrong.
const ENROLMENTS = [
    { id: 1, employeeId: 159, deviceUserId: '2', tenantId: TRUSOFT, effectiveFrom: new Date('2024-01-01'), effectiveTo: new Date('2026-08-31') },
    { id: 2, employeeId: 159, deviceUserId: '306', tenantId: TRUSOFT, effectiveFrom: new Date('2026-09-01'), effectiveTo: null },
    { id: 3, employeeId: 900, deviceUserId: '2', tenantId: HOMENET, effectiveFrom: new Date('2026-09-01'), effectiveTo: null },
];

const prismaMock = {
    employeeDeviceEnrolment: { findMany: jest.fn(async () => ENROLMENTS) },
    employee: { findMany: jest.fn(async () => []) },
};
const mcpCtxMock = { run: jest.fn(async (_ctx, fn) => fn()) };

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/mcp/context.js', () => ({ mcpCtx: mcpCtxMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { resolveEnrolmentAt } = await import('../../src/services/deviceEnrolment.service.js');

const at = (iso) => new Date(`${iso}T09:00:00.000Z`);

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.employeeDeviceEnrolment.findMany.mockResolvedValue(ENROLMENTS);
});

describe('HR-ATT-DEVICE-ENROLMENT-01 point-in-time resolution', () => {
    it('resolves a punch to the id that was current when it happened', async () => {
        const map = await resolveEnrolmentAt(['2'], at('2026-05-10'));

        expect(map.get('2')).toMatchObject({ employeeId: 159, tenantId: TRUSOFT });
    });

    it('does NOT give Afsha a punch under her OLD id after it was reissued', async () => {
        // 15 September: `2` belongs to somebody else now. This is the case a
        // multi-value id list on Employee gets wrong.
        const map = await resolveEnrolmentAt(['2'], at('2026-09-15'));

        expect(map.get('2')).toMatchObject({ employeeId: 900, tenantId: HOMENET });
    });

    it('resolves her NEW id from the day it took effect', async () => {
        const map = await resolveEnrolmentAt(['306'], at('2026-09-15'));

        expect(map.get('306')).toMatchObject({ employeeId: 159 });
    });

    it('leaves an id unresolved before its enrolment begins', async () => {
        const map = await resolveEnrolmentAt(['306'], at('2026-08-15'));

        expect(map.get('306')).toBeUndefined();
    });

    it('leaves an id unresolved after its enrolment ends', async () => {
        // Faizan's `1` stopped in July; a punch under it in December is not his.
        prismaMock.employeeDeviceEnrolment.findMany.mockResolvedValue([
            { id: 9, employeeId: 178, deviceUserId: '1', tenantId: TRUSOFT, effectiveFrom: new Date('2024-01-01'), effectiveTo: new Date('2026-07-31') },
        ]);
        const map = await resolveEnrolmentAt(['1'], at('2026-12-01'));

        expect(map.get('1')).toBeUndefined();
    });

    it('treats a null effectiveTo as still current', async () => {
        const map = await resolveEnrolmentAt(['306'], at('2027-06-01'));

        expect(map.get('306')).toMatchObject({ employeeId: 159 });
    });

    it('picks the LATEST enrolment when two overlap, rather than guessing', async () => {
        // Overlapping rows are bad data. Silently picking one at random moves
        // attendance between people; the newest is at least deterministic.
        prismaMock.employeeDeviceEnrolment.findMany.mockResolvedValue([
            { id: 1, employeeId: 1, deviceUserId: '7', tenantId: TRUSOFT, effectiveFrom: new Date('2024-01-01'), effectiveTo: null },
            { id: 2, employeeId: 2, deviceUserId: '7', tenantId: TRUSOFT, effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
        ]);
        const map = await resolveEnrolmentAt(['7'], at('2026-09-01'));

        expect(map.get('7').employeeId).toBe(2);
    });

    it('runs under SYSTEM context — one device serves every tenant', async () => {
        await resolveEnrolmentAt(['2'], at('2026-05-10'));

        expect(mcpCtxMock.run).toHaveBeenCalledWith(
            expect.objectContaining({ system: true }),
            expect.any(Function),
        );
    });
});
