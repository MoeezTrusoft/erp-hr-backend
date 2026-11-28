// HR-ATT-SCOPE-01 — every employee holds hr:attendance VIEW for their own rows.
// These tools return the whole company (every person's days, the CSV export,
// month reconciliation, headcount totals, submitted timesheets) and used to need
// only that VIEW: on dev a plain employee read employees 1, 2 and 6's attendance.
import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) }),
}));

const { registerAllTools } = await import('../../../src/mcp/toolRegistry.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
registerAllTools({
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  registerTool: () => {},
  resource: () => {},
});
const USER = { userId: '3', employeeId: '1', tenantId: 't1', isAdmin: false };
const EMPLOYEE = { 'hr:attendance': ['VIEW'], 'hr:leave': ['VIEW'] };
const HR = { 'hr:attendance': ['VIEW', 'EDIT'] };
const call = (name, args, permissions) => mcpCtx.run({ user: USER, permissions }, () => handlers.get(name)(args));
const status = (res) => { try { return JSON.parse(res.content[0].text).status; } catch { return 200; } };

const TOOLS = [
  ['hr_attendance_records_dashboard', {}],
  ['hr_attendance_dashboard_export', { format: 'csv' }],
  ['hr_attendance_dashboard_get', {}],
  ['hr_attendance_pending_approvals', {}],
  ['hr_attendance_reconciliation', { from: '2026-11-01', to: '2026-11-30' }],
  ['hr_attendance_daily_summary', {}],
];

describe('HR-ATT-SCOPE-01 company attendance is an HR view', () => {
  it.each(TOOLS)('%s refuses a plain employee', async (name, args) => {
    const res = await call(name, args, EMPLOYEE);
    expect(status(res)).toBe(403);
    expect(res.content[0].text).toContain('company attendance is an HR view');
  });

  it.each(TOOLS)('%s lets HR past the gate', async (name, args) => {
    const res = await call(name, args, HR);
    expect(res.content[0].text).not.toContain('company attendance is an HR view');
  });

  it('the dead self check-in tool is gone', () => {
    expect(handlers.has('hr_self_checkin')).toBe(false);
  });
});
