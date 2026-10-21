// HR-ATT-SCOPE-02 (2026-10-21, operator item 19) — the timesheet scope's two
// option sources:
//
//   - departments: every department the company has, not just the ones that
//     resolved for the selected date window (otherwise a department with no
//     scheduled staff simply vanished from the select);
//   - employees: the search box matches NAME or code, and the permission scope
//     still constrains a line manager to their own staff. The scope is itself
//     an OR, so getting the combination wrong here would leak other managers'
//     employees — that is the case worth pinning.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const employeeFindMany = jest.fn();
const employeeFindFirst = jest.fn();
const employeeCount = jest.fn();
const businessUnitFindMany = jest.fn();

const prismaMock = {
    employee: { findMany: employeeFindMany, findFirst: employeeFindFirst, count: employeeCount },
    businessUnit: { findMany: businessUnitFindMany },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../src/lib/attendanceRuntime.js', () => ({
    loadAttendanceRuntime: jest.fn(async () => ({
        resolve: (employeeId) => ({
            departmentId: employeeId === 1 ? 'dept-ops' : null,
            shift: null,
            sites: [],
        }),
    })),
}));

const service = await import('../../src/services/attendanceRules.service.js');

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const hr = { tenantId: TENANT, roles: [{ name: 'HR Manager' }] };
const manager = { tenantId: TENANT, employeeId: 77, roles: [{ name: 'Line Manager' }] };

beforeEach(() => {
    jest.clearAllMocks();
    employeeFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    employeeFindFirst.mockResolvedValue(null);
    employeeCount.mockResolvedValue(0);
});

describe('HR-ATT-SCOPE-02 scope options', () => {
    it('returns every company department, not only the resolved ones', async () => {
        businessUnitFindMany.mockResolvedValue([
            { id: 'dept-fin', name: 'Finance' },
            { id: 'dept-ops', name: 'Operations' },
            { id: 'dept-people', name: 'People' },
        ]);

        const options = await service.attendanceFilterOptions(
            { user: hr, from: '2026-02-01', to: '2026-02-28' },
            prismaMock,
        );

        // The runtime above only resolves dept-ops, yet all three survive.
        expect(options.departments).toEqual([
            { id: 'dept-fin', name: 'Finance' },
            { id: 'dept-ops', name: 'Operations' },
            { id: 'dept-people', name: 'People' },
        ]);
    });

    it('searches employee names as well as codes', async () => {
        await service.employeeCodeOptions({ user: hr, q: 'Ayesha', page: 1, pageSize: 25 }, prismaMock);

        const where = employeeFindMany.mock.calls[0][0].where;
        expect(where.tenant_id).toBe(TENANT);
        const fields = where.AND[0].OR.flatMap((clause) => Object.keys(clause));
        expect(fields).toEqual(
            expect.arrayContaining(['employee_code', 'first_name', 'last_name']),
        );
    });

    it('keeps the manager scope ANDed with the name search', async () => {
        await service.employeeCodeOptions({ user: manager, q: 'Bilal', page: 1, pageSize: 25 }, prismaMock);

        const where = employeeFindMany.mock.calls[0][0].where;
        // Two clauses: the permission scope and the search. A flat spread would
        // have let the second OR overwrite the first.
        expect(where.AND).toHaveLength(2);
        expect(where.AND[0].OR).toEqual([{ id: 77 }, { managerId: 77 }]);
        expect(where.AND[1].OR).toEqual(
            expect.arrayContaining([{ first_name: { contains: 'Bilal', mode: 'insensitive' } }]),
        );
    });

    it('pages the matches and returns a total for infinite scroll', async () => {
        employeeFindMany.mockResolvedValue([
            {
                id: 5,
                employee_code: 'EMP-005',
                first_name: 'Ayesha',
                last_name: 'Khan',
                status: 'ACTIVE',
                businessUnit: { name: 'Operations' },
            },
        ]);
        employeeCount.mockResolvedValue(26);

        const page = await service.employeeCodeOptions(
            { user: hr, q: '', page: 2, pageSize: 25 },
            prismaMock,
        );

        expect(employeeFindMany.mock.calls[0][0]).toMatchObject({ skip: 25, take: 25 });
        expect(page.items).toEqual([
            {
                id: 5,
                code: 'EMP-005',
                name: 'Ayesha Khan',
                department: 'Operations',
                status: 'ACTIVE',
                activeFrom: undefined,
            },
        ]);
        expect(page).toMatchObject({ total: 26, page: 2, pageSize: 25 });
    });

    it('finds an employee by code even when the name does not match', async () => {
        employeeFindFirst.mockResolvedValue({
            id: 9,
            employee_code: 'EMP-009',
            first_name: 'Zara',
            last_name: 'Yousuf',
        });

        const page = await service.employeeCodeOptions(
            { user: hr, q: 'EMP-009', page: 1, pageSize: 25 },
            prismaMock,
        );

        expect(employeeFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ employee_code: { equals: 'EMP-009', mode: 'insensitive' } }),
            }),
        );
        expect(page.items[0]).toMatchObject({ code: 'EMP-009', name: 'Zara Yousuf' });
    });
});
