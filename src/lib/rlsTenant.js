// src/lib/rlsTenant.js — FORCE ROW LEVEL SECURITY tenant-context extension.
//
// The c2_rls_pilot migration puts FORCE RLS on Attendance / LeaveRequest /
// PerformanceReview with the policy
//     USING/CHECK (tenantId = public.hr_current_tenant())
// where hr_current_tenant() = current_setting('app.tenant_id', true)::uuid.
//
// So every read/write of those tables must run with the right GUC set:
//   • TENANT context  → app.tenant_id = the VERIFIED request tenant (RBAC Company
//     uuid on user.tenantId, never a spoofable header).
//   • SYSTEM context   → app.tenant_bypass = 'on', so trusted cross-tenant jobs
//     (mcpCtx.run({ system: true }) — reminder sweep, dispatchers) can scan every
//     tenant's rows. WITHOUT this, a SYSTEM job sets no GUC and FORCE-RLS hides
//     EVERY row (the review-reminder job was silently blind). The policy carries
//     the matching `OR app.tenant_bypass='on'` clause (hr_rls_bypass_guc migration).
// We wrap each such operation in a transaction that sets the GUC transaction-
// locally via set_config(..., true) and runs the operation in the SAME
// transaction (a batch $transaction shares one connection). Non-RLS models and
// no-context queries are passed straight through (the tenantScope extension
// denies genuinely context-less callers before they reach here).
import { mcpCtx } from '../mcp/context.js';

// INTERACTIVE-TRANSACTION helper. The $allOperations extension below sets the
// GUC in its OWN batch $transaction, which does NOT apply to the connection of
// an interactive `prisma.$transaction(async (tx) => …)` — so writes to RLS
// tables inside an interactive tx fail the WITH CHECK (hr_current_tenant() is
// NULL there). Any interactive transaction that touches an RLS table must run
// through this helper, which sets app.tenant_id (tenant ctx) / app.tenant_bypass
// (SYSTEM ctx) as the FIRST statement inside the tx. Pass an explicit tenantId
// when the caller has the verified tenant in hand (e.g. createEmployee); else it
// falls back to the ambient mcpCtx tenant.
export function tenantTransaction(client, fn, opts = {}) {
    return client.$transaction(async (tx) => {
        const store = mcpCtx.getStore();
        if (opts.system || store?.system) {
            await tx.$executeRaw`SELECT set_config('app.tenant_bypass', 'on', true)`;
        } else {
            const t = opts.tenantId ?? store?.user?.tenantId;
            if (t) {
                await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t)}, true)`;
            }
        }
        return fn(tx);
    }, opts.txOptions);
}

// Pilot tables under FORCE ROW LEVEL SECURITY. Prisma MODEL names (the extension
// keys on `model`), not physical table names. Extended beyond the original
// 3-table pilot to the Tier-1 high-PII tables (bank details, comp/salary,
// emergency contacts) — all reached only via the ORM (no raw SQL), all callers
// already gated by tenantScope, none scanned by cross-tenant jobs. Each table's
// DB policy carries the `OR app.tenant_bypass='on'` clause so SYSTEM jobs still
// see across tenants. Physical tables: bank_details, employment_terms,
// EmergencyContacts (see hr_rls_pilot_extend migration).
const RLS_MODELS = new Set([
    'Attendance',
    'LeaveRequest',
    'PerformanceReview',
    'BankDetail',
    'EmploymentTerms',
    'EmergencyContacts',
    // Payroll + Timesheet transactional tables (audit: ORM-only, no cross-tenant
    // SYSTEM sweep — the only SYSTEM contexts, reminder-queue + outbox-dispatcher,
    // never read these; all callers gated by tenantScope via REST/MCP tenant ctx).
    'PayrollRun',
    'PayrollPayslip',
    'PayrollEarning',
    'PayrollDeduction',
    'PayrollAssignment',
    'PayrollAuditLog',
    'Timesheet',
    'TimeEntry',
    'TimeApproval',
    // Payroll reference/lookup tables — data check confirmed 0 null-tenant
    // (global) rows, so FORCE RLS hides nothing; per-tenant config only.
    'PayrollEarningType',
    'PayrollDeductionType',
    // TEN-2 fleet extend (2026-07-23): the remaining 78 tenant-owned HR tables,
    // all forced by 20260723020000_hr_rls_fleet_extend with a DEFAULT
    // hr_current_tenant() create-stamp net. (Employee [tenant_id column] and
    // OutboxEvent [NOT NULL infra] deferred to a dedicated follow-up.)
    'DashboardLayout', 'EmployeeMedia', 'BusinessUnit', 'GradeLevel', 'Log', 'Leave',
    'LeavePolicy', 'LeaveRequestApproval', 'LeaveBalance', 'ApprovalWorkflow',
    'ApprovalWorkflowStep', 'Region', 'HolidayCalendar', 'Holiday', 'EmployeeHolidayCalendar',
    'OvertimeRule', 'ShiftTemplate', 'ShiftAssignment', 'ShiftSwapRequest', 'OvertimeRequest',
    'WorkSchedule', 'Source', 'ReviewFeedback', 'Position', 'JobRequisition',
    'RequisitionApproval', 'JobPosting', 'TrainingCategory', 'TrainingCourse',
    'TrainingEnrollment', 'PerformanceCycle', 'PerformanceTemplate', 'Goal', 'GoalProgress',
    'GoalAlignment', 'ReviewReminder', 'CalibrationSession', 'RatingAdjustment', 'TaxRate',
    'Tag', 'Candidate', 'CandidateSkill', 'CandidateTag', 'Application', 'PerformanceMetric',
    'PerformanceReviewItem', 'OnboardingChecklist', 'OnboardingSession', 'OnboardingTask',
    'OnboardingDocument', 'OnboardingBuddy', 'OnboardingSurvey', 'Interview',
    'InterviewInterviewer', 'InterviewScorecard', 'Offer', 'TalentPool', 'RecruitmentCostConfig',
    'LearningPath', 'LearningPathCourse', 'LearningPathEnrollment', 'TrainingSession',
    'TrainingSessionAttendee', 'Certification', 'Recognition', 'Skill', 'EmployeeSkill',
    // Course-catalog (LMS) tables — new in 20260724_hr_course_catalog. FORCE-RLS
    // with a DEFAULT hr_current_tenant() create-stamp, same as the fleet.
    'CourseSection', 'CourseLecture', 'CourseOutcome', 'CourseReview',
    'EmployeeLifecycleEvent', 'OffboardingChecklist', 'OffboardingTask', 'ComplianceChecklist',
    'ComplianceItem', 'DocumentExpiryAlert', 'DevelopmentPlan', 'DevelopmentPlanItem',
    'ReimbursementClaim', 'BenefitPlan', 'EmployeeBenefit',
    // Deferred D1/D2 (2026-07-23): Employee (tenant_id col) + OutboxEvent.
    'Employee', 'OutboxEvent',
]);
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const rlsTenantExtension = (client) =>
    client.$extends({
        name: 'rls-tenant-guc',
        query: {
            $allModels: {
                async $allOperations({ model, args, query }) {
                    if (!RLS_MODELS.has(model)) return query(args);
                    const store = mcpCtx.getStore();

                    // SYSTEM context: set the bypass GUC so cross-tenant jobs can
                    // read/write pilot tables under FORCE RLS.
                    if (store?.system) {
                        const [, result] = await client.$transaction([
                            client.$executeRaw`SELECT set_config('app.tenant_bypass', 'on', true)`,
                            query(args),
                        ]);
                        return result;
                    }

                    const tenantId = store?.user?.tenantId;
                    if (!tenantId || !UUID_RE.test(String(tenantId))) {
                        return query(args);
                    }
                    const [, result] = await client.$transaction([
                        client.$executeRaw`SELECT set_config('app.tenant_id', ${String(
                            tenantId,
                        )}, true)`,
                        query(args),
                    ]);
                    return result;
                },
            },
        },
    });
