// tests/unit/mcp/regionHoliday.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR region + holiday calendar tools (10 tools).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/holiday.service.js', () => ({
  getRegions: jest.fn(async () => ({ success: true })),
  getRegionById: jest.fn(async () => ({ success: true })),
  createRegion: jest.fn(async () => ({ success: true })),
  updateRegion: jest.fn(async () => ({ success: true })),
  deleteRegion: jest.fn(async () => ({ success: true })),
  getHolidayCalendars: jest.fn(async () => ({ success: true })),
  getHolidayCalendarById: jest.fn(async () => ({ success: true })),
  createHolidayCalendar: jest.fn(async () => ({ success: true })),
  updateHolidayCalendar: jest.fn(async () => ({ success: true })),
  deleteHolidayCalendar: jest.fn(async () => ({ success: true })),
}));

const { registerRegionTools } = await import('../../../src/mcp/tools/regionTools.js');
const { registerHolidayCalendarTools } = await import('../../../src/mcp/tools/holidayCalendarTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerRegionTools(recording);
registerHolidayCalendarTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_region_list', gate: 'hr:holiday', action: 'VIEW', args: {} },
  { name: 'hr_region_get', gate: 'hr:holiday', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_region_create', gate: 'hr:holiday', action: 'CREATE', args: { name: 'EMEA' } },
  { name: 'hr_region_update', gate: 'hr:holiday', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_region_delete', gate: 'hr:holiday', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_holiday_calendar_list', gate: 'hr:holiday', action: 'VIEW', args: {} },
  { name: 'hr_holiday_calendar_get', gate: 'hr:holiday', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_holiday_calendar_create', gate: 'hr:holiday', action: 'CREATE', args: { name: 'US Holidays 2026', year: 2026 } },
  { name: 'hr_holiday_calendar_update', gate: 'hr:holiday', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_holiday_calendar_delete', gate: 'hr:holiday', action: 'DELETE', args: { id: '1' } },
];

describe('REGION-HOLIDAY-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to service and returns result', async () => {
    const res = await call(name, args, { permissions: grant });
    expect(res).toBeDefined();
    expect(res.content).toBeDefined();
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content[0].type).toBe('text');
  });

  it('deny-by-default: no permission blob -> 403', async () => {
    const res = await call(name, args, { permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });

  it('forged isAdmin grants nothing (still 403)', async () => {
    const res = await call(name, args, { user: { ...USER, isAdmin: true }, permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });
});
