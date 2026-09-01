// HR-ATT-POLICY-01 — Payroll Setup attendance MCP tools.
//
// Registration-time smoke coverage: a bad zod shape or a wrong permission
// argument here does not fail at import, it fails at 3am when someone opens the
// screen. Two things matter most:
//   1. every tool is gated on the EXISTING hr:payroll key — invent a new key and
//      it 403s at runtime because nothing seeded it;
//   2. assertPermission receives an HTTP METHOD, not an action name. METHOD_ACTION
//      maps POST->CREATE and PUT->EDIT, so passing "CREATE" silently bypasses the
//      check.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const ctx = { user: { tenantId: 'a3f1c2d4-0000-4000-8000-000000000001', isAdmin: false }, permissions: [] };
const assertPermissionMock = jest.fn();

jest.unstable_mockModule('../../src/mcp/context.js', () => ({
    mcpCtx: { getStore: () => ctx },
}));
jest.unstable_mockModule('../../src/mcp/utils/assertPermission.js', () => ({
    assertPermission: assertPermissionMock,
}));
jest.unstable_mockModule('../../src/mcp/utils/toolError.js', () => ({
    withToolError: (fn) => fn,
}));
jest.unstable_mockModule('../../src/services/attendancePolicyConfig.service.js', () => ({
    getAttendancePolicy: jest.fn(async () => ({ id: 1 })),
    updateAttendancePolicy: jest.fn(async (a) => ({ ok: true, ...a })),
}));
jest.unstable_mockModule('../../src/services/attendanceDeductionRule.service.js', () => ({
    DEDUCTION_RULE_KEYS: ['DISAPPROVED_LEAVE', 'LATE', 'MISSING_CHECKIN', 'MISSING_CHECKOUT', 'EARLY_CHECKOUT'],
    listDeductionRules: jest.fn(async () => []),
    upsertDeductionRule: jest.fn(async (a) => ({ ok: true, ...a })),
}));
jest.unstable_mockModule('../../src/services/attendanceApprovalLevel.service.js', () => ({
    listApprovalLevels: jest.fn(async () => []),
    listApproverCandidates: jest.fn(async () => []),
    upsertApprovalLevel: jest.fn(async (a) => ({ ok: true, ...a })),
    deleteApprovalLevel: jest.fn(async (a) => ({ deleted: true, ...a })),
}));

const { registerAttendanceSetupTools } = await import('../../src/mcp/tools/attendanceSetupTools.js');
const approvals = await import('../../src/services/attendanceApprovalLevel.service.js');

function makeServer() {
    const tools = new Map();
    return {
        tools,
        tool: (name, description, schema, handler) => tools.set(name, { description, schema, handler }),
    };
}

let server;
beforeEach(() => {
    jest.clearAllMocks();
    server = makeServer();
    registerAttendanceSetupTools(server);
});

const EXPECTED = [
    'hr_attendance_policy_get',
    'hr_attendance_policy_update',
    'hr_attendance_deduction_rules_list',
    'hr_attendance_deduction_rule_upsert',
    'hr_attendance_approval_levels_list',
    'hr_attendance_approver_candidates_list',
    'hr_attendance_approval_level_upsert',
    'hr_attendance_approval_level_delete',
];

describe('HR-ATT-POLICY-01 attendance setup tools', () => {
    it('registers every tool exactly once', () => {
        expect([...server.tools.keys()].sort()).toEqual([...EXPECTED].sort());
    });

    it('gates every tool on the existing hr:payroll key', async () => {
        for (const name of EXPECTED) {
            assertPermissionMock.mockClear();
            await server.tools.get(name).handler({ level: 1, ruleKey: 'LATE' });

            expect(assertPermissionMock).toHaveBeenCalledTimes(1);
            expect(assertPermissionMock.mock.calls[0][2]).toBe('hr:payroll');
        }
    });

    it('passes HTTP methods to assertPermission, never action names', async () => {
        const methods = {};
        for (const name of EXPECTED) {
            assertPermissionMock.mockClear();
            await server.tools.get(name).handler({ level: 1, ruleKey: 'LATE' });
            methods[name] = assertPermissionMock.mock.calls[0][1];
        }

        expect(methods.hr_attendance_policy_get).toBe('GET');
        expect(methods.hr_attendance_policy_update).toBe('PUT');
        expect(methods.hr_attendance_approval_level_delete).toBe('DELETE');
        // METHOD_ACTION only understands HTTP verbs; an action name would pass silently.
        for (const m of Object.values(methods)) {
            expect(['GET', 'POST', 'PUT', 'DELETE']).toContain(m);
        }
    });

    it('takes the tenant from the verified context, never from arguments', async () => {
        // A caller-supplied tenantId must not be able to reach the service.
        await server.tools.get('hr_attendance_approval_level_upsert').handler({
            level: 2, role: 'HR', approverId: 5, tenantId: 'attacker-tenant',
        });

        const arg = approvals.upsertApprovalLevel.mock.calls[0][0];
        expect(arg.tenantId).toBe(ctx.user.tenantId);
    });

    it('returns JSON text content', async () => {
        const res = await server.tools.get('hr_attendance_deduction_rules_list').handler({});

        expect(res.content[0].type).toBe('text');
        expect(() => JSON.parse(res.content[0].text)).not.toThrow();
    });
});
