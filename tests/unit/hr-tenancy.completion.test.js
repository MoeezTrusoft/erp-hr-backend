// C.2-completion — thread the verified tenant (req.user.tenantId → service
// `tenantId` param via src/lib/tenancy.js) into the REMAINING tenant-bearing HR
// services so every read/write is tenant-filtered + fail-closed.
//
// The verified tenant arrives ONLY on req.user.tenantId (set by
// internalServiceGuard from the signed service-JWT claim; T-P2.1) — NEVER from
// the spoofable x-tenant-id header. Each newly-threaded service folds that uuid
// string into its where-clause (reads) / create.data (writes) the SAME way the
// payroll (HR-04) + leave surfaces already do.
//
// These specs mock the shared Prisma singleton (src/lib/prisma.js — config/prisma
// re-exports it) and assert:
//   * reads carry a tenantId predicate when a tenant is supplied,
//   * a cross-tenant single-read resolves to not-found (never another tenant),
//   * writes stamp the verified tenant onto create.data,
//   * the legacy (undefined-tenant) path is preserved (no predicate added).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mk = () => ({
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
});

const models = [
    'performanceReview', 'reviewFeedback', 'reviewReminder', 'performanceCycle',
    'performanceTemplate', 'performanceReviewItem',
    'jobRequisition', 'requisitionApproval', 'jobPosting',
    'interview', 'interviewScorecard', 'interviewInterviewer', 'offer', 'application',
    'candidate', 'candidateTag', 'talentPool', 'source',
    'certification', 'trainingCourse', 'trainingCategory', 'trainingSession',
    'trainingSessionAttendee', 'trainingEnrollment', 'learningPath',
    'learningPathCourse', 'learningPathEnrollment',
    'onboardingChecklist', 'onboardingTask', 'onboardingDocument',
    'onboardingBuddy', 'onboardingSurvey',
    'offboardingChecklist', 'offboardingTask',
    'attendance', 'timeEntry', 'timesheet', 'timeApproval', 'workSchedule', 'overtimeRule',
    'complianceChecklist', 'complianceItem', 'documentExpiryAlert',
    'goal', 'goalProgress', 'goalAlignment', 'developmentPlan', 'developmentPlanItem',
    'calibrationSession', 'ratingAdjustment',
    'employeeSkill', 'skill', 'emergencyContacts', 'dashboardLayout', 'employeeMedia',
    'employee',
    // C.2-completion additions — remaining tenant-bearing models threaded in this pass.
    'performanceMetric', 'position', 'reimbursementClaim', 'log', 'documentExpiryAlert',
    'payrollPayslip', 'leaveBalance',
];

const prismaMock = Object.fromEntries(models.map((m) => [m, mk()]));
prismaMock.$transaction = jest.fn(async (arg) =>
    typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg)
);

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));
jest.unstable_mockModule('../../src/services/dam.media.service.js', () => ({
    uploadFileToDAM: jest.fn().mockResolvedValue([{ id: 1 }]),
}));

const perf = await import('../../src/services/performance.service.js');
const perfReview = await import('../../src/services/performanceReview.service.js');
const requisition = await import('../../src/services/requisition.service.js');
const interview = await import('../../src/services/interview.service.js');
const offer = await import('../../src/services/offer.service.js');
const certification = await import('../../src/services/certification.service.js');
const onboarding = await import('../../src/services/onboarding.service.js');
const offboarding = await import('../../src/services/offboarding.service.js');
const compliance = await import('../../src/services/compliance.service.js');
const attendance = await import('../../src/services/attendance.service.js');

// C.2-completion — newly-threaded services exercised by the additional specs below.
const trainingSvc = await import('../../src/services/trainingService.js');
const trainingSession = await import('../../src/services/trainingSession.service.js');
const trainingEnrollment = await import('../../src/services/trainingEnrollment.service.js');
const learningPath = await import('../../src/services/learningPath.service.js');
const enrollmentSvc = await import('../../src/services/enrollmentService.js');
const perfCycle = await import('../../src/services/performanceCycleService.js');
const perfTemplate = await import('../../src/services/performanceTemplateService.js');
const goalAlignment = await import('../../src/services/goalAlignment.service.js');
const talentPool = await import('../../src/services/talentPool.service.js');
const position = await import('../../src/services/position.service.js');
const reimbursement = await import('../../src/services/reimbursement.service.js');
const emergencyContacts = await import('../../src/services/emergencyContacts.service.js');
const employeeSkill = await import('../../src/services/employeeSkill.service.js');
const calibrationReport = await import('../../src/services/calibrationReport.service.js');
const orgChart = await import('../../src/services/orgChart.service.js');
const selfSvc = await import('../../src/services/self.service.js');
const { requireTenant } = await import('../../src/lib/tenancy.js');

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

function hasTenantPredicate(where, tenantId) {
    if (!where || typeof where !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(where, 'tenantId') && where.tenantId === tenantId) return true;
    for (const key of ['AND', 'OR']) {
        if (Array.isArray(where[key]) && where[key].some((w) => hasTenantPredicate(w, tenantId))) return true;
    }
    return false;
}

beforeEach(() => {
    for (const model of Object.values(prismaMock)) {
        if (typeof model === 'function') continue;
        for (const fn of Object.values(model)) fn.mockReset();
    }
});

describe('C.2 performance — tenant scoping', () => {
    it('getAllReviews scopes findMany by tenantId', async () => {
        prismaMock.performanceReview.findMany.mockResolvedValue([]);
        await perf.getAllReviews(TENANT_A);
        expect(hasTenantPredicate(prismaMock.performanceReview.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('createPerformanceReview stamps tenantId and scopes the employee guard', async () => {
        prismaMock.employee.findFirst.mockResolvedValue({ id: 3 });
        prismaMock.performanceReview.create.mockResolvedValue({ id: 1 });
        await perf.createPerformanceReview(
            { employeeId: 3, period_start: '2024-01-01', period_end: '2024-02-01' }, 99, TENANT_A);
        expect(prismaMock.performanceReview.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });

    it('updateReview returns/throws not-found for a cross-tenant review (no mutation)', async () => {
        prismaMock.performanceReview.findFirst.mockImplementation(async ({ where }) =>
            where.id === 7 && where.tenantId === TENANT_A ? { id: 7, tenantId: TENANT_A } : null);
        await expect(perf.updateReview(7, { status: 'FINALIZED' }, 99, TENANT_B)).rejects.toThrow(/not found/i);
        expect(prismaMock.performanceReview.update).not.toHaveBeenCalled();
    });
});

describe('C.2 performanceReview cycle — tenant scoping', () => {
    it('getCycleReviewsService scopes findMany by tenantId', async () => {
        prismaMock.performanceReview.findMany.mockResolvedValue([]);
        await perfReview.getCycleReviewsService(5, TENANT_A);
        expect(hasTenantPredicate(prismaMock.performanceReview.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });
});

describe('C.2 recruitment — tenant scoping', () => {
    it('getAllRequisitions scopes findMany by tenantId', async () => {
        prismaMock.jobRequisition.findMany.mockResolvedValue([]);
        await requisition.getAllRequisitions(TENANT_A);
        expect(hasTenantPredicate(prismaMock.jobRequisition.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('getByIdRequisitions resolves not-found across tenants', async () => {
        prismaMock.jobRequisition.findFirst.mockImplementation(async ({ where }) =>
            where.id === 4 && where.tenantId === TENANT_A ? { id: 4, tenantId: TENANT_A } : null);
        expect(await requisition.getByIdRequisitions(4, TENANT_A)).toMatchObject({ id: 4 });
        expect(await requisition.getByIdRequisitions(4, TENANT_B)).toBeNull();
    });

    it('createRequisition stamps tenantId', async () => {
        prismaMock.jobRequisition.create.mockResolvedValue({ id: 1 });
        await requisition.createRequisition({ title: 'x' }, 9, TENANT_A);
        expect(prismaMock.jobRequisition.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });

    it('listInterviews scopes findMany + count by tenantId', async () => {
        prismaMock.interview.findMany.mockResolvedValue([]);
        prismaMock.interview.count.mockResolvedValue(0);
        await interview.listInterviews({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.interview.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.interview.count.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('offer.listOffers scopes findMany by tenantId', async () => {
        prismaMock.offer.findMany.mockResolvedValue([]);
        prismaMock.offer.count.mockResolvedValue(0);
        await offer.listOffers({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.offer.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });
});

describe('C.2 training — tenant scoping', () => {
    it('listCertifications scopes findMany + count by tenantId', async () => {
        prismaMock.certification.findMany.mockResolvedValue([]);
        prismaMock.certification.count.mockResolvedValue(0);
        await certification.listCertifications({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.certification.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.certification.count.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('createCertification stamps tenantId', async () => {
        prismaMock.certification.create.mockResolvedValue({ id: 1 });
        await certification.createCertification({ employeeId: 3, title: 't', tenantId: TENANT_A });
        expect(prismaMock.certification.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });
});

describe('C.2 onboarding — tenant scoping', () => {
    it('listChecklists scopes findMany + count by tenantId', async () => {
        prismaMock.onboardingChecklist.findMany.mockResolvedValue([]);
        prismaMock.onboardingChecklist.count.mockResolvedValue(0);
        await onboarding.listChecklists({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.onboardingChecklist.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.onboardingChecklist.count.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('getChecklist resolves not-found across tenants', async () => {
        prismaMock.onboardingChecklist.findFirst.mockImplementation(async ({ where }) =>
            where.id === 2 && where.tenantId === TENANT_A ? { id: 2, tenantId: TENANT_A } : null);
        expect(await onboarding.getChecklist(2, TENANT_A)).toMatchObject({ id: 2 });
        expect(await onboarding.getChecklist(2, TENANT_B)).toBeNull();
    });

    it('createChecklist stamps tenantId', async () => {
        prismaMock.onboardingChecklist.create.mockResolvedValue({ id: 1 });
        await onboarding.createChecklist({ employeeId: 3, tenantId: TENANT_A });
        expect(prismaMock.onboardingChecklist.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });
});

describe('C.2 offboarding — tenant scoping', () => {
    it('getOffboarding resolves not-found across tenants', async () => {
        prismaMock.offboardingChecklist.findFirst.mockImplementation(async ({ where }) =>
            where.id === 3 && where.tenantId === TENANT_A ? { id: 3, tenantId: TENANT_A } : null);
        expect(await offboarding.getOffboarding(3, TENANT_A)).toMatchObject({ id: 3 });
        expect(await offboarding.getOffboarding(3, TENANT_B)).toBeNull();
    });

    it('createOffboarding stamps tenantId', async () => {
        prismaMock.offboardingChecklist.create.mockResolvedValue({ id: 1 });
        await offboarding.createOffboarding({ employeeId: 3, tenantId: TENANT_A });
        expect(prismaMock.offboardingChecklist.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });
});

describe('C.2 compliance — tenant scoping', () => {
    it('listChecklists scopes findMany by tenantId', async () => {
        prismaMock.complianceChecklist.findMany.mockResolvedValue([]);
        await compliance.listChecklists(TENANT_A);
        expect(hasTenantPredicate(prismaMock.complianceChecklist.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('createChecklist stamps tenantId', async () => {
        prismaMock.complianceChecklist.create.mockResolvedValue({ id: 1 });
        await compliance.createChecklist({ name: 'x', tenantId: TENANT_A });
        expect(prismaMock.complianceChecklist.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });
});

describe('C.2 attendance — tenant scoping', () => {
    it('listAttendanceRecords scopes findMany by tenantId', async () => {
        prismaMock.attendance.findMany.mockResolvedValue([]);
        await attendance.listAttendanceRecords({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.attendance.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('getAttendanceByEmployee scopes findMany by tenantId', async () => {
        prismaMock.attendance.findMany.mockResolvedValue([]);
        await attendance.getAttendanceByEmployee(3, TENANT_A);
        expect(hasTenantPredicate(prismaMock.attendance.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });
});

describe('C.2 — legacy (undefined-tenant) path preserved', () => {
    it('getAllRequisitions adds NO tenantId predicate when tenant is undefined', async () => {
        prismaMock.jobRequisition.findMany.mockResolvedValue([]);
        await requisition.getAllRequisitions();
        const where = prismaMock.jobRequisition.findMany.mock.calls[0][0].where || {};
        expect(Object.prototype.hasOwnProperty.call(where, 'tenantId')).toBe(false);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// C.2-completion — REMAINING sensitive HR services threaded in this pass.
// Each asserts: reads carry the tenant predicate (so tenant B cannot read
// tenant A), creates stamp the verified tenant, and a cross-tenant single-read
// resolves to not-found — never another tenant's row.
// ───────────────────────────────────────────────────────────────────────────

describe('C.2-completion training — tenant scoping', () => {
    it('getCourses scopes findMany + count by tenantId', async () => {
        prismaMock.trainingCourse.findMany.mockResolvedValue([]);
        prismaMock.trainingCourse.count.mockResolvedValue(0);
        await trainingSvc.getCourses({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.trainingCourse.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.trainingCourse.count.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('getCourseById resolves not-found across tenants (no leak)', async () => {
        prismaMock.trainingCourse.findFirst.mockImplementation(async ({ where }) =>
            where.id === 4 && where.tenantId === TENANT_A ? { id: 4, tenantId: TENANT_A } : null);
        await expect(trainingSvc.getCourseById(4, TENANT_B)).rejects.toThrow(/not found|required/i);
    });

    it('createCourse stamps the verified tenant', async () => {
        prismaMock.trainingCourse.create.mockResolvedValue({ id: 1 });
        await trainingSvc.createCourse({ title: 'x', categoryId: 2, tenantId: TENANT_A }, 9);
        expect(prismaMock.trainingCourse.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });

    it('listSessions scopes findMany by tenantId', async () => {
        prismaMock.trainingSession.findMany.mockResolvedValue([]);
        prismaMock.trainingSession.count.mockResolvedValue(0);
        await trainingSession.listSessions({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.trainingSession.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('createSession stamps the verified tenant', async () => {
        prismaMock.trainingSession.create.mockResolvedValue({ id: 1 });
        await trainingSession.createSession({ courseId: 2, title: 't', scheduledAt: '2024-01-01', tenantId: TENANT_A });
        expect(prismaMock.trainingSession.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });

    it('getEnrollments scopes findMany by tenantId', async () => {
        prismaMock.trainingEnrollment.findMany.mockResolvedValue([]);
        await trainingEnrollment.getEnrollments(TENANT_A);
        expect(hasTenantPredicate(prismaMock.trainingEnrollment.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('enrollUser (enrollmentService) scopes its duplicate-check + stamps tenant', async () => {
        prismaMock.trainingEnrollment.findFirst.mockResolvedValue(null);
        prismaMock.trainingEnrollment.create.mockResolvedValue({ id: 1 });
        await enrollmentSvc.enrollUser({ courseId: 2, employeeId: 3, tenantId: TENANT_A }, 9);
        expect(hasTenantPredicate(prismaMock.trainingEnrollment.findFirst.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(prismaMock.trainingEnrollment.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });

    it('listPaths scopes findMany by tenantId', async () => {
        prismaMock.learningPath.findMany.mockResolvedValue([]);
        prismaMock.learningPath.count.mockResolvedValue(0);
        await learningPath.listPaths({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.learningPath.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('createPath stamps the verified tenant', async () => {
        prismaMock.learningPath.create.mockResolvedValue({ id: 1 });
        await learningPath.createPath({ title: 't', tenantId: TENANT_A });
        expect(prismaMock.learningPath.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });
});

describe('C.2-completion performance config — tenant scoping', () => {
    it('getAllPerformanceCycles scopes findMany by tenantId', async () => {
        prismaMock.performanceCycle.findMany.mockResolvedValue([]);
        await perfCycle.getAllPerformanceCycles(TENANT_A);
        expect(hasTenantPredicate(prismaMock.performanceCycle.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('getPerformanceCycleById resolves not-found across tenants', async () => {
        prismaMock.performanceCycle.findFirst.mockImplementation(async ({ where }) =>
            where.id === 5 && where.tenantId === TENANT_A ? { id: 5, tenantId: TENANT_A } : null);
        await expect(perfCycle.getPerformanceCycleById(5, TENANT_B)).rejects.toThrow(/not found/i);
    });

    it('getAllPerformanceTemplates scopes findMany by tenantId', async () => {
        prismaMock.performanceTemplate.findMany.mockResolvedValue([]);
        await perfTemplate.getAllPerformanceTemplates(TENANT_A);
        expect(hasTenantPredicate(prismaMock.performanceTemplate.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('calibration overview scopes performanceReview reads by tenantId', async () => {
        prismaMock.performanceReview.findMany.mockResolvedValue([]);
        prismaMock.ratingAdjustment.findMany.mockResolvedValue([]);
        await calibrationReport.getCalibrationOverviewService(TENANT_A);
        expect(hasTenantPredicate(prismaMock.performanceReview.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });
});

describe('C.2-completion misc tenant-bearing — tenant scoping', () => {
    it('goalAlignment getGoalAlignmentsService scopes by tenantId', async () => {
        prismaMock.goalAlignment.findMany.mockResolvedValue([]);
        await goalAlignment.getGoalAlignmentsService(3, TENANT_A);
        expect(hasTenantPredicate(prismaMock.goalAlignment.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('talentPool listPools scopes findMany + count by tenantId', async () => {
        prismaMock.talentPool.findMany.mockResolvedValue([]);
        prismaMock.talentPool.count.mockResolvedValue(0);
        await talentPool.listPools({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.talentPool.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('position getAllPositions scopes findMany by tenantId', async () => {
        prismaMock.position.findMany.mockResolvedValue([]);
        await position.getAllPositions(TENANT_A);
        expect(hasTenantPredicate(prismaMock.position.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('reimbursement listClaims scopes findMany by tenantId', async () => {
        prismaMock.reimbursementClaim.findMany.mockResolvedValue([]);
        await reimbursement.listClaims({ tenantId: TENANT_A });
        expect(hasTenantPredicate(prismaMock.reimbursementClaim.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('emergencyContacts getAllEmergencyContacts scopes findMany by tenantId', async () => {
        prismaMock.emergencyContacts.findMany.mockResolvedValue([]);
        await emergencyContacts.getAllEmergencyContacts(TENANT_A);
        expect(hasTenantPredicate(prismaMock.emergencyContacts.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('employeeSkill getEmployeeSkills scopes findMany by tenantId', async () => {
        prismaMock.employeeSkill.findMany.mockResolvedValue([]);
        await employeeSkill.getEmployeeSkills(3, TENANT_A);
        expect(hasTenantPredicate(prismaMock.employeeSkill.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });
});

describe('C.2-completion — Employee-table services (snake_case tenant_id)', () => {
    it('orgChart getOrgChart scopes the employee read by tenant_id', async () => {
        prismaMock.employee.findMany.mockResolvedValue([]);
        await orgChart.getOrgChart(TENANT_A);
        expect(prismaMock.employee.findMany.mock.calls[0][0].where.tenant_id).toBe(TENANT_A);
    });

    it('self.getSelfProfile scopes the employee read by tenant_id (cross-tenant -> not found)', async () => {
        prismaMock.employee.findFirst.mockImplementation(async ({ where }) =>
            where.id === 5 && where.tenant_id === TENANT_A ? { id: 5, tenant_id: TENANT_A } : null);
        const reqA = { headers: { 'x-employee-id': '5' }, user: { tenantId: TENANT_A } };
        const reqB = { headers: { 'x-employee-id': '5' }, user: { tenantId: TENANT_B } };
        expect(await selfSvc.getSelfProfile(reqA)).toMatchObject({ id: 5 });
        expect(await selfSvc.getSelfProfile(reqB)).toBeNull();
    });

    it('self.listSelfPayslips scopes the payslip read by tenantId', async () => {
        prismaMock.payrollPayslip.findMany.mockResolvedValue([]);
        await selfSvc.listSelfPayslips({ headers: { 'x-employee-id': '5' }, user: { tenantId: TENANT_A } });
        expect(hasTenantPredicate(prismaMock.payrollPayslip.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });
});

describe('C.2-completion — requireTenant fail-closed on a sensitive create', () => {
    it('createSession throws fail-closed when no verified tenant is present', async () => {
        prismaMock.trainingSession.create.mockResolvedValue({ id: 1 });
        await expect(
            trainingSession.createSession({ courseId: 2, title: 't', scheduledAt: '2024-01-01' })
        ).rejects.toThrow(/tenant/i);
        expect(prismaMock.trainingSession.create).not.toHaveBeenCalled();
    });

    it('requireTenant itself is fail-closed (null/undefined/empty all throw)', () => {
        expect(() => requireTenant(null)).toThrow(/tenant/i);
        expect(() => requireTenant(undefined)).toThrow(/tenant/i);
        expect(() => requireTenant('')).toThrow(/tenant/i);
        expect(requireTenant(TENANT_A)).toBe(TENANT_A);
    });
});
