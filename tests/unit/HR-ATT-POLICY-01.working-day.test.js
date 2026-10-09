// HR-ATT-POLICY-01 — working-day resolution.
//
// The cutoff rule branches on this: when tomorrow is a working day the search
// for a missing check-out closes at the next shift's check-in; when it is not,
// it closes at shift end plus a leniency window. Getting the verdict wrong moves
// the boundary, which decides whether a day is flagged MISSING_CHECKOUT and
// eventually deducted.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const EMP = 100;
const TENANT='14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';

let schedule;
let holidays;
let leaves;
let assignedCalendars;

const prismaMock = {
  attendanceSetupRelease:{findMany:jest.fn(async()=>[{version:1,effectiveFrom:'2020-01-01',coverageThrough:'2030-12-31',config:{
    version:1,policy:{},settings:{defaultCalendarId:1},employees:[{id:EMP,status:'active'}],periods:[],
    schedules:schedule?[{...schedule,employeeId:EMP,effective_start_date:'2020-01-01'}]:[],
    calendars:[{id:1},{id:2},{id:9}],holidays:holidays.map(h=>({holidayCalendarId:1,...h})),
    calendarAssignments:assignedCalendars.map(c=>({employeeId:EMP,effectiveFrom:'2020-01-01',...c}))
  }}])},
  shiftAssignment:{findMany:jest.fn(async()=>[])},leaveRequest:{findMany:jest.fn(async()=>[])},
  leave:{findMany:jest.fn(async()=>leaves.map(l=>({...l,employeeId:EMP})))},attendanceCallIn:{findMany:jest.fn(async()=>[])}
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));

const svc = await import('../../src/services/workingDay.service.js');

const d = (s) => { const x = new Date(s); x.setHours(0, 0, 0, 0); return x; };

beforeEach(() => {
    jest.clearAllMocks();
    // Sat+Sun off, matching most of this roster.
    schedule = { schedule_pattern: { offDays: [6, 7], shift: { from: '10:00', to: '18:00' } } };
    holidays = [];
    leaves = [];
    assignedCalendars = [];
});

describe('HR-ATT-POLICY-01 working days', () => {
    it('threads tenant scope into every working-day source query', async () => {
        const tenantId = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
        await svc.resolveWorkingDays({ tenantId, employeeId: EMP, from: '2026-08-14', to: '2026-08-17' });

        for(const model of Object.values(prismaMock))expect(model.findMany.mock.calls[0][0].where.tenantId).toBe(tenantId);
    });

    it('marks rostered off-days non-working', async () => {
        // 2026-08-14 is a Friday; 15th Sat, 16th Sun, 17th Mon.
        const map = await svc.resolveWorkingDays({ tenantId: TENANT, employeeId: EMP, from: '2026-08-14', to: '2026-08-17' });

        expect(map.get('2026-08-14').working).toBe(true);
        expect(map.get('2026-08-15')).toMatchObject({ working: false, reason: 'OFF_DAY' });
        expect(map.get('2026-08-16')).toMatchObject({ working: false, reason: 'OFF_DAY' });
        expect(map.get('2026-08-17').working).toBe(true);
    });

    it('treats a full-day holiday as non-working', async () => {
        holidays = [{ date: d('2026-08-14'), name: 'Independence Day', fullDay: true }];

        const map = await svc.resolveWorkingDays({ tenantId: TENANT, employeeId: EMP, from: '2026-08-14', to: '2026-08-14' });

        expect(map.get('2026-08-14')).toMatchObject({ working: false, reason: 'HOLIDAY', holidayName: 'Independence Day' });
    });

    it('keeps a half-day holiday a working day', async () => {
        holidays = [{ date: d('2026-08-14'), name: 'Half Day', fullDay: false, startTime:'10:00',endTime:'14:00' }];

        const map = await svc.resolveWorkingDays({ tenantId: TENANT, employeeId: EMP, from: '2026-08-14', to: '2026-08-14' });

        expect(map.get('2026-08-14').working).toBe(true);
    });

    it('treats approved leave as non-working across its whole span', async () => {
        leaves = [{ start_date: d('2026-08-12'), end_date: d('2026-08-14'), type: 'Annual' }];

        const map = await svc.resolveWorkingDays({ tenantId: TENANT, employeeId: EMP, from: '2026-08-11', to: '2026-08-14' });

        expect(map.get('2026-08-11').working).toBe(true);
        for (const day of ['2026-08-12', '2026-08-13', '2026-08-14']) {
            expect(map.get(day)).toMatchObject({ working: false, reason: 'APPROVED_LEAVE' });
        }
    });

    it('reports leave ahead of a holiday on the same day', async () => {
        // Not doubly off — the strongest reason wins, and leave is the one that
        // explains the person's absence.
        holidays = [{ date: d('2026-08-14'), name: 'Some Holiday', fullDay: true }];
        leaves = [{ start_date: d('2026-08-14'), end_date: d('2026-08-14'), type: 'Annual' }];

        const map = await svc.resolveWorkingDays({ tenantId: TENANT, employeeId: EMP, from: '2026-08-14', to: '2026-08-14' });

        expect(map.get('2026-08-14').reason).toBe('APPROVED_LEAVE');
    });

    it('ignores leave that is not approved', async () => {
        // The service filters on status APPROVED; a pending request must not
        // silently excuse the day.
        await svc.resolveWorkingDays({ tenantId: TENANT, employeeId: EMP, from: '2026-08-14', to: '2026-08-14' });

        expect(prismaMock.leave.findMany.mock.calls[0][0].where.status).toBe('APPROVED');
    });

    it('holds days when the employee has no published roster', async () => {
        schedule = null;

        const map = await svc.resolveWorkingDays({ tenantId: TENANT, employeeId: EMP, from: '2026-08-15', to: '2026-08-16' });

        expect(map.get('2026-08-15')).toMatchObject({working:null,reason:'MISSING_ROSTER'});
        expect(map.get('2026-08-16')).toMatchObject({working:null,reason:'MISSING_ROSTER'});
    });

    it('applies only the calendars the employee is assigned to', async () => {
        // Two groups in one tenant can observe different days. Calendar 1 is the
        // employee's; calendar 2 belongs to someone else and must not apply.
        assignedCalendars = [{ holidayCalendarId: 1 }];
        holidays = [
            { date: d('2026-08-14'), name: 'Ours', fullDay: true, holidayCalendarId: 1 },
            { date: d('2026-08-13'), name: 'Theirs', fullDay: true, holidayCalendarId: 2 },
        ];

        const map = await svc.resolveWorkingDays({ tenantId: TENANT, employeeId: EMP, from: '2026-08-13', to: '2026-08-14' });

        expect(map.get('2026-08-13').working).toBe(true);          // not our calendar
        expect(map.get('2026-08-14')).toMatchObject({ working: false, reason: 'HOLIDAY' });
    });

    it('uses only the explicit tenant default when the employee has no calendar assignment', async () => {
        // Current reality: one calendar per tenant, nobody explicitly assigned.
        assignedCalendars = [];
        holidays = [{ date: d('2026-08-14'), name: 'Independence Day', fullDay: true, holidayCalendarId: 9 }];

        const map = await svc.resolveWorkingDays({ tenantId: TENANT, employeeId: EMP, from: '2026-08-14', to: '2026-08-14' });

        expect(map.get('2026-08-14').working).toBe(true);
    });

    it('answers a single day through isWorkingDay', async () => {
        const sat = await svc.isWorkingDay({ tenantId: TENANT, employeeId: EMP, date: '2026-08-15' });

        expect(sat).toMatchObject({ working: false, reason: 'OFF_DAY' });
    });
});
