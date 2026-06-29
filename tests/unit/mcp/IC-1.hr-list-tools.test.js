// tests/unit/mcp/IC-1.hr-list-tools.test.js
//
// IC-1 — the HR frontend (domains/hr/api/hr-client.js) binds six LIST screens to
// hr_*_list MCP TOOLS via callTool (tools/call), but the HR backend exposed
// those names ONLY as RESOURCES (resources/read). The tools/call dispatch 404'd,
// so the screens fell back to mock data. This suite pins the six NEW list TOOLS:
//   * each is registered as a TOOL (not merely a same-named resource),
//   * each dispatches to the EXISTING list service-controller carrying the
//     VERIFIED tenant (ctx.user.tenantId) — never a body/arg value,
//   * each is deny-by-default gated on the SAME entitlement the REST surface
//     uses (hr:attendance / hr:recruitment / hr:leave / hr:payroll /
//     hr:performance) for the VIEW action,
//   * each returns the FE-expected paginated envelope { items, total, page,
//     pageSize } that hr-schemas `parseHrCollection` accepts — regardless of the
//     heterogeneous { data } / { data:{items} } / { reviews } controller shapes.
//
// DB-free: the thin MCP service-controllers are mocked so the tool→controller
// dispatch + gate + envelope contract is asserted directly.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Each tool file statically imports its FULL controller surface, so ESM linking
// requires every named export to be present on the mock. We stub them all with
// jest.fn() and give the six LIST functions realistic (heterogeneous) payloads
// so the envelope-normalization is exercised end-to-end.
const stub = (names, overrides = {}) =>
  names.reduce((acc, n) => ({ ...acc, [n]: jest.fn() }), { ...overrides });

jest.unstable_mockModule('../../../src/mcp/controllers/attendanceMcpController.js', () =>
  stub(
    ['mcpApproveTimesheet', 'mcpCheckIn', 'mcpCheckOut', 'mcpAttendanceDailySummary',
     'mcpCreateOvertimeRule', 'mcpCreateTimeEntry', 'mcpCreateTimesheet', 'mcpDeviceConnectivity',
     'mcpDeviceSyncAttendance', 'mcpCreateWorkSchedule', 'mcpDeleteOvertimeRule', 'mcpDeleteTimeEntry',
     'mcpDeleteWorkSchedule', 'mcpGetAttendanceByEmployee', 'mcpListOvertimeRules', 'mcpListTimeEntries',
     'mcpListTimesheets', 'mcpListWorkSchedules', 'mcpUpdateOvertimeRule', 'mcpUpdateTimeEntry',
     'mcpUpdateWorkSchedule'],
    { mcpListAttendanceRecords: jest.fn(async () => ({ success: true, data: [{ id: 'att-1' }] })) }
  )
);
jest.unstable_mockModule('../../../src/mcp/controllers/leaveMcpController.js', () =>
  stub(
    ['mcpApproveLeaveRequest', 'mcpCancelLeaveRequest', 'mcpCreateHoliday', 'mcpCreateLeavePolicy',
     'mcpCreateLeaveRequest', 'mcpDeleteLeavePolicy', 'mcpListHolidays', 'mcpListLeaveBalances',
     'mcpListLeavePolicies', 'mcpListPendingLeaveApprovals', 'mcpRejectLeaveRequest', 'mcpRunLeaveAccruals',
     'mcpUpdateLeaveBalance', 'mcpUpdateLeavePolicy'],
    { mcpListLeaveRequests: jest.fn(async () => ({ success: true, data: [{ id: 'leave-1' }] })) }
  )
);
jest.unstable_mockModule('../../../src/mcp/controllers/recruitmentMcpController.js', () =>
  stub(
    ['mcpApproveRequisition', 'mcpCreateApplication', 'mcpCreateCandidate', 'mcpCreateInterview',
     'mcpCreateOffer', 'mcpCreateRequisition', 'mcpAddTalentPool', 'mcpDeleteRequisition',
     'mcpListApplications', 'mcpListRecruitmentTags', 'mcpListInterviews', 'mcpListOffers',
     'mcpListTalentPool', 'mcpPostRequisition', 'mcpRemoveTalentPool', 'mcpSendOffer',
     'mcpUpdateApplicationStage', 'mcpUpdateApplicationStatus', 'mcpUpdateCandidate',
     'mcpUpdateInterview', 'mcpUpdateRequisition', 'mcpUpdateOffer'],
    {
      mcpListRequisitions: jest.fn(async () => ({ success: true, data: [{ id: 'req-1' }] })),
      mcpListCandidates: jest.fn(async () => ({
        success: true,
        message: 'Success',
        data: { items: [{ id: 'cand-1' }], total: 7, page: 1, limit: 20 },
      })),
    }
  )
);
jest.unstable_mockModule('../../../src/mcp/controllers/payrollMcpController.js', () =>
  stub(
    ['mcpCancelPayrollRun', 'mcpCreateDeductionType', 'mcpCreateEarningType', 'mcpCreateEmploymentTerms',
     'mcpCreatePayrollAssignment', 'mcpCreatePayrollRun', 'mcpDistributePayslip', 'mcpFinalizePayrollRun',
     'mcpListDeductionTypes', 'mcpListEarningTypes', 'mcpListPayrollAuditLogs', 'mcpListPayrollRuns',
     'mcpProcessPayrollRun', 'mcpExportBankDisbursementFile'],
    { mcpListPayslips: jest.fn(async () => ({ success: true, data: { items: [{ id: 'pay-1' }], total: 3 } })) }
  )
);
jest.unstable_mockModule('../../../src/mcp/controllers/taxFormMcpController.js', () => ({
  mcpListYearEndTaxForms: jest.fn(),
  mcpExportYearEndTaxForms: jest.fn(),
}));
jest.unstable_mockModule('../../../src/mcp/controllers/performanceMcpController.js', () =>
  stub(
    ['mcpAddPerformanceFeedback', 'mcpAdjustCalibrationRating', 'mcpApproveGoal', 'mcpCreateCalibration',
     'mcpCreateDevelopmentPlan', 'mcpCreateGoal', 'mcpCreatePerformanceReview', 'mcpFinalizeCalibration',
     'mcpListCalibrationSessions', 'mcpListGoals', 'mcpListPerformanceMetrics', 'mcpRecordGoalProgress',
     'mcpUpdateGoal', 'mcpUpdatePerformanceReview'],
    { mcpListPerformanceReviews: jest.fn(async () => ({ success: true, reviews: [{ id: 'rev-1' }] })) }
  )
);

const attendanceCtl = await import('../../../src/mcp/controllers/attendanceMcpController.js');
const leaveCtl = await import('../../../src/mcp/controllers/leaveMcpController.js');
const recruitmentCtl = await import('../../../src/mcp/controllers/recruitmentMcpController.js');
const payrollCtl = await import('../../../src/mcp/controllers/payrollMcpController.js');
const performanceCtl = await import('../../../src/mcp/controllers/performanceMcpController.js');

const { registerAttendanceTools } = await import('../../../src/mcp/tools/attendanceTools.js');
const { registerLeaveTools } = await import('../../../src/mcp/tools/leaveTools.js');
const { registerRecruitmentTools } = await import('../../../src/mcp/tools/recruitmentTools.js');
const { registerPayrollTools } = await import('../../../src/mcp/tools/payrollTools.js');
const { registerPerformanceTools } = await import('../../../src/mcp/tools/performanceTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

// Capture registered TOOL handlers (resources are ignored — this is the gap).
const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerAttendanceTools(recording);
registerLeaveTools(recording);
registerRecruitmentTools(recording);
registerPayrollTools(recording);
registerPerformanceTools(recording);

const USER = {
  userId: '7',
  email: 'hr@acme.test',
  roles: ['HR_ADMIN'],
  isAdmin: false, // forgeable flag must NOT grant anything
  employeeId: '7',
  tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}

const parse = (res) => JSON.parse(res.content[0].text);

// name, input args, controller mock accessor, gate key
const CASES = [
  ['hr_attendance_list', { page: 1, pageSize: 10 }, () => attendanceCtl.mcpListAttendanceRecords, 'hr:attendance', 'att-1'],
  ['hr_leave_requests_list', { page: 1, pageSize: 10 }, () => leaveCtl.mcpListLeaveRequests, 'hr:leave', 'leave-1'],
  ['hr_requisitions_list', { page: 1, pageSize: 10 }, () => recruitmentCtl.mcpListRequisitions, 'hr:recruitment', 'req-1'],
  ['hr_candidates_list', { page: 1, pageSize: 10 }, () => recruitmentCtl.mcpListCandidates, 'hr:recruitment', 'cand-1'],
  ['hr_payslips_list', { page: 1, pageSize: 10 }, () => payrollCtl.mcpListPayslips, 'hr:payroll', 'pay-1'],
  ['hr_performance_reviews_list', { page: 1, pageSize: 10 }, () => performanceCtl.mcpListPerformanceReviews, 'hr:performance', 'rev-1'],
];

describe('IC-1 — hr_*_list MCP tools (FE list-screen binding)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers all six list tools as TOOLS', () => {
    for (const [name] of CASES) expect(handlers.has(name)).toBe(true);
  });

  describe.each(CASES)('%s', (name, args, ctlOf, gateKey, sentinelId) => {
    const grant = { [gateKey]: ['VIEW'] };

    it('returns the FE paginated envelope { items, total, page, pageSize }', async () => {
      const res = await call(name, args, { permissions: grant });
      expect(res.isError).toBeFalsy();
      const body = parse(res);
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items[0]).toMatchObject({ id: sentinelId });
      expect(body).toMatchObject({ page: 1, pageSize: 10 });
      expect(typeof body.total).toBe('number');
    });

    it('dispatches to the existing service-controller with the verified tenant', async () => {
      await call(name, args, { permissions: grant });
      expect(ctlOf()).toHaveBeenCalledTimes(1);
      expect(ctlOf().mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-A' });
    });

    it('is deny-by-default: no permission blob → 403 and the service is never called', async () => {
      const res = await call(name, args, { permissions: {} });
      expect(res.isError).toBe(true);
      expect(parse(res).status).toBe(403);
      expect(ctlOf()).not.toHaveBeenCalled();
    });

    it('a forged isAdmin grants nothing (still 403)', async () => {
      const res = await call(name, args, { user: { ...USER, isAdmin: true }, permissions: {} });
      expect(res.isError).toBe(true);
      expect(parse(res).status).toBe(403);
      expect(ctlOf()).not.toHaveBeenCalled();
    });

    it(`requires ${gateKey}:VIEW specifically (wrong action → 403)`, async () => {
      const res = await call(name, args, { permissions: { [gateKey]: ['CREATE', 'EDIT', 'DELETE'] } });
      expect(res.isError).toBe(true);
      expect(parse(res).status).toBe(403);
      expect(ctlOf()).not.toHaveBeenCalled();
    });
  });
});
