// HR-FE-UNBLOCK-01 — three fields the services already handle but no read or
// write path exposes, so the frontend cannot build against them.
//
// Each of these is a service that does the right thing behind a tool or select
// that forgot to carry the field:
//
//   1. counterGroup — attendanceDeductionRule.service.js validates it, pools
//      counters by it, and RETURNS it from list, but the upsert tool's zod
//      shape omits it. So it is readable and unwritable: the UI can show a
//      pooling group it can never set.
//   2. employeeId on hr_timesheet_kpis — the KPI cards are tenant-wide, so an
//      employee's own profile cannot show its own attendance KPIs at all.
//   3. biometric_id — the ZKTeco enrolment key that device intake matches on.
//      No employee read path selects it, so it is invisible everywhere in the
//      product despite deciding whether a person's attendance records at all.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/** Body of `server.tool("<name>", ... )` up to the handler. */
function toolSource(source, name) {
    const start = source.indexOf(`"${name}"`);
    if (start === -1) return '';
    return source.slice(start, start + 2500);
}

describe('HR-FE-UNBLOCK-01 counterGroup is writable, not just readable', () => {
    const tools = read('src/mcp/tools/attendanceSetupTools.js');

    test('hr_attendance_deduction_rule_upsert accepts counterGroup', () => {
        // Without this the "3 missed punches of EITHER kind = 1 day" grouping
        // the service enforces cannot be configured from the UI at all.
        expect(toolSource(tools, 'hr_attendance_deduction_rule_upsert')).toContain('counterGroup');
    });

    test('the service still validates it, so the tool is not the only guard', () => {
        const service = read('src/services/attendanceDeductionRule.service.js');
        expect(service).toContain('counterGroup must be');
        expect(service).toContain('must share the same');
    });
});

describe('HR-FE-UNBLOCK-01 timesheet KPIs can be scoped to one employee', () => {
    test('the tool accepts employeeId', () => {
        const tools = read('src/mcp/tools/timesheetReportTools.js');
        expect(toolSource(tools, 'hr_timesheet_kpis')).toContain('employeeId');
    });

    test('the service filters on it rather than ignoring it', () => {
        const service = read('src/services/timesheetReport.service.js');
        const fn = service.slice(service.indexOf('export async function getTimesheetKpis'));
        expect(fn.slice(0, 200)).toContain('employeeId');
    });
});

describe('HR-FE-UNBLOCK-01 biometric_id is visible on the employee profile', () => {
    const profile = read('src/services/employeeProfileTabs.service.js');

    test('the prisma select carries it', () => {
        expect(profile).toMatch(/biometric_id:\s*true/);
    });

    test('employmentDetails returns it', () => {
        const block = profile.slice(profile.indexOf('employmentDetails: {'));
        expect(block.slice(0, 1400)).toContain('biometricId');
    });
});
