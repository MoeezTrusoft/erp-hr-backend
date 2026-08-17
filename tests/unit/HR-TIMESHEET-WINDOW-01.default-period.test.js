// HR-TIMESHEET-WINDOW-01 — the Time & Attendance screen's two tools must agree
// on what "no date filter" means.
//
// Observed live: hr_checkinout_list returned rows dated 2026-06-24 while
// hr_timesheet_kpis reported all-zero counts for the same nominal period. Both
// tools DO apply from/to identically when the values parse — the divergence was
// in the default:
//
//   hr_timesheet_kpis   no window -> resolvePeriod -> current calendar month
//   hr_checkinout_list  no window -> no where.date -> ALL TIME, newest first
//
// so a cleared date picker (which sends from: "", and parseDate("") is null)
// produced a June-heavy table beside August-zero tiles. Same default now, and
// the applied window is echoed back so a caller can verify it.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';

const attendanceFindMany = jest.fn().mockResolvedValue([]);
const employeeCount = jest.fn().mockResolvedValue(0);
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
    default: {
        attendance: { findMany: attendanceFindMany },
        employee: { count: employeeCount },
    },
}));

const { listCheckInOuts, getTimesheetKpis } = await import('../../src/services/timesheetReport.service.js');

const whereOf = (mock) => mock.mock.calls[0][0].where;
const monthBounds = () => {
    const now = new Date();
    return {
        from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)),
        to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999)),
    };
};

beforeEach(() => {
    attendanceFindMany.mockClear();
    employeeCount.mockClear();
});

describe('HR-TIMESHEET-WINDOW-01: default window', () => {
    it('check-in/out defaults to the current calendar month instead of all time', async () => {
        await listCheckInOuts({ tenantId: TENANT });
        const { from, to } = monthBounds();
        expect(whereOf(attendanceFindMany).date).toEqual({ gte: from, lte: to });
    });

    it('treats a blank window (cleared date picker) the same as an absent one', async () => {
        await listCheckInOuts({ tenantId: TENANT, from: '', to: '' });
        const { from, to } = monthBounds();
        expect(whereOf(attendanceFindMany).date).toEqual({ gte: from, lte: to });
    });

    it('agrees with hr_timesheet_kpis on that default, to the millisecond', async () => {
        await listCheckInOuts({ tenantId: TENANT });
        const tableWindow = whereOf(attendanceFindMany).date;

        attendanceFindMany.mockClear();
        await getTimesheetKpis({ tenantId: TENANT });
        const kpiWindow = whereOf(attendanceFindMany).date;

        expect(tableWindow).toEqual(kpiWindow);
    });

    it('still honours an explicit window', async () => {
        await listCheckInOuts({ tenantId: TENANT, from: '2026-06-01', to: '2026-06-30' });
        const { date } = whereOf(attendanceFindMany);
        expect(date.gte.toISOString()).toBe('2026-06-01T00:00:00.000Z');
        expect(date.lte.toISOString()).toBe('2026-06-30T23:59:59.999Z');
    });

    it('echoes the applied window back, in the same shape the KPIs return', async () => {
        const res = await listCheckInOuts({ tenantId: TENANT, from: '2026-06-01', to: '2026-06-30' });
        expect(res.period).toEqual({
            from: '2026-06-01T00:00:00.000Z',
            to: '2026-06-30T23:59:59.999Z',
        });
        expect(res).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('keeps other filters working alongside the window', async () => {
        await listCheckInOuts({ tenantId: TENANT, status: 'late', employeeId: '151' });
        const where = whereOf(attendanceFindMany);
        expect(where.date).toBeDefined();
        expect(where.status).toBeDefined();
        expect(where.employeeId).toBe(151);
    });
});
