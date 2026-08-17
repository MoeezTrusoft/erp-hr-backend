// REQ-HR-004 — hr://timesheets threw a RAW Prisma validation error at the FE.
//
// Reported banner text (verbatim, from the live capture):
//   Invalid `prisma.timesheet.findMany()` invocation:
//   { where: { tenantId: "…", + employeeId: { equals: Int | … } } }
//   Argument `employeeId` is missing.
//
// Two defects, both fixed here:
//   1. getTimesheets built `{ employeeId: parseInt(employeeId) }` unconditionally.
//      A caller with no resolvable employee record (an operator account —
//      requireEmployeeActor returns null for admins) made that `parseInt(null)`
//      => NaN, and a NaN in an Int filter makes Prisma reject the whole query.
//      getTimeEntries had the identical bug one file over.
//   2. MCP *resources* were not wrapped by an error mapper the way *tools* are,
//      so that Prisma text escaped verbatim to the browser (an ERR-3 leak).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';

const findMany = jest.fn().mockResolvedValue([]);
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
    default: { timesheet: { findMany }, timeEntry: { findMany } },
}));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: jest.fn() }));

const timesheetService = await import('../../src/services/timesheetService.js');
const timeEntryService = await import('../../src/services/timeEntryService.js');
const { withResourceError } = await import('../../src/mcp/utils/toolError.js');

beforeEach(() => findMany.mockClear());

describe('REQ-HR-004: employee scoping never produces a NaN filter', () => {
    it('omits employeeId entirely when the caller has no employee record', async () => {
        await timesheetService.getTimesheets({ employeeId: null, tenantId: TENANT });
        const { where } = findMany.mock.calls[0][0];
        expect(where).not.toHaveProperty('employeeId');
        expect(where.tenantId).toBe(TENANT);
    });

    it('omits employeeId for undefined too (the shape the resource read sends)', async () => {
        await timesheetService.getTimesheets({ tenantId: TENANT });
        expect(findMany.mock.calls[0][0].where).not.toHaveProperty('employeeId');
    });

    it('still scopes to the employee when one is supplied', async () => {
        await timesheetService.getTimesheets({ employeeId: '151', tenantId: TENANT });
        expect(findMany.mock.calls[0][0].where.employeeId).toBe(151);
    });

    it('never puts NaN in the filter for a junk id', async () => {
        await timesheetService.getTimesheets({ employeeId: 'not-a-number', tenantId: TENANT });
        expect(findMany.mock.calls[0][0].where).not.toHaveProperty('employeeId');
    });

    it('applies the same rule to time entries', async () => {
        await timeEntryService.getTimeEntries({ employeeId: null, tenantId: TENANT });
        expect(findMany.mock.calls[0][0].where).not.toHaveProperty('employeeId');

        findMany.mockClear();
        await timeEntryService.getTimeEntries({ employeeId: 151, tenantId: TENANT });
        expect(findMany.mock.calls[0][0].where.employeeId).toBe(151);
    });
});

describe('REQ-HR-004: resource reads never leak a raw driver error', () => {
    it('maps a thrown Prisma-style error to a leak-safe MCP payload', async () => {
        const boom = Object.assign(
            new Error('Invalid `prisma.timesheet.findMany()` invocation: Argument `employeeId` is missing.'),
            { name: 'PrismaClientValidationError' },
        );
        const handler = withResourceError(async () => { throw boom; }, 'hr://timesheets');

        const res = await handler({ href: 'hr://timesheets' });

        expect(res.isError).toBe(true);
        const body = JSON.parse(res.contents[0].text);
        expect(body.error).not.toMatch(/prisma/i);
        expect(body.error).not.toMatch(/employeeId/);
        expect(body.code).toMatch(/^HR-\d{4}$/);
        expect(res.contents[0].mimeType).toBe('application/json');
    });

    it('passes a successful read straight through', async () => {
        const handler = withResourceError(
            async (uri) => ({ contents: [{ uri: uri.href, text: '[]', mimeType: 'application/json' }] }),
            'hr://timesheets',
        );
        const res = await handler({ href: 'hr://timesheets' });
        expect(res.isError).toBeUndefined();
        expect(res.contents[0].text).toBe('[]');
    });
});
