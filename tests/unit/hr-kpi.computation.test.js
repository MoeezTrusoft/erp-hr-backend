// tests/unit/hr-kpi.computation.test.js
//
// TDD coverage for the REAL HR KPI computations that replace the previously
// hardcoded/placeholder values (notably timeToFill = 42).
//
// Steered findings:
//   HR-KPI-04  Time to Fill (requisition-approved -> offer-accepted) per category
//   HR-KPI-05  Appraisal completion % (and on-time %) per cycle
//   HR-KPI-06  Payroll accuracy + on-time rate per run
//   HR-KPI-07  KPI targets / out-of-range evaluation
//   HR-REC-09  Recruitment funnel KPIs (incl. offer-acceptance)
//   HR-ANL-02  EEO / diversity counts from real Employee columns
//
// Pure-function KPIs are tested directly; the service-layer wiring is tested
// with a mocked prisma singleton (same pattern as analyticsService.test.js).

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const mockJobRequisitionFindMany = jest.fn();
const mockPerformanceReviewFindMany = jest.fn();
const mockPayrollRunFindMany = jest.fn();
const mockEmployeeFindMany = jest.fn();

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
    default: {
        jobRequisition: { findMany: mockJobRequisitionFindMany },
        performanceReview: { findMany: mockPerformanceReviewFindMany },
        payrollRun: { findMany: mockPayrollRunFindMany },
        employee: { findMany: mockEmployeeFindMany },
    },
}));

jest.unstable_mockModule('../../src/utils/logs.js', () => ({
    logAction: jest.fn(),
}));

const utils = await import('../../src/utils/analyticsUtils.js');
const {
    computeTimeToFill,
    computeAppraisalCompletion,
    computePayrollKpis,
    computeRecruitmentFunnel,
    evaluateKpiTarget,
    evaluateKpiTargets,
    KPI_TARGETS,
} = utils;

const {
    getRecruitmentDashboard,
    getPerformanceDashboard,
    getPayrollKpis,
    generateEEOReport,
} = await import('../../src/services/analyticsService.js');

beforeEach(() => {
    jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// HR-KPI-04 — Time to Fill
// ---------------------------------------------------------------------------
describe('HR-KPI-04 computeTimeToFill', () => {
    test('computes day count between approval and acceptance', () => {
        const r = computeTimeToFill([
            { approvedAt: '2026-01-01T00:00:00Z', acceptedAt: '2026-01-31T00:00:00Z', category: 'Engineering' },
        ]);
        expect(r.count).toBe(1);
        expect(r.avgDays).toBe(30);
        expect(r.medianDays).toBe(30);
        expect(r.byCategory).toEqual([
            { category: 'Engineering', avgDays: 30, medianDays: 30, count: 1 },
        ]);
    });

    test('averages and medians across multiple filled requisitions', () => {
        const r = computeTimeToFill([
            { approvedAt: '2026-01-01', acceptedAt: '2026-01-11', category: 'Sales' }, // 10
            { approvedAt: '2026-01-01', acceptedAt: '2026-01-21', category: 'Sales' }, // 20
            { approvedAt: '2026-01-01', acceptedAt: '2026-01-31', category: 'Sales' }, // 30
        ]);
        expect(r.count).toBe(3);
        expect(r.avgDays).toBe(20);
        expect(r.medianDays).toBe(20);
    });

    test('is NOT the old hardcoded 42', () => {
        const r = computeTimeToFill([
            { approvedAt: '2026-01-01', acceptedAt: '2026-01-08', category: 'X' }, // 7
        ]);
        expect(r.avgDays).toBe(7);
        expect(r.avgDays).not.toBe(42);
    });

    test('guard: skips rows missing either anchor', () => {
        const r = computeTimeToFill([
            { approvedAt: '2026-01-01', category: 'X' },        // no acceptedAt
            { acceptedAt: '2026-01-10', category: 'X' },        // no approvedAt
            { approvedAt: null, acceptedAt: null, category: 'X' },
        ]);
        expect(r.count).toBe(0);
        expect(r.avgDays).toBeNull();
        expect(r.medianDays).toBeNull();
    });

    test('guard: skips negative durations (accepted before approved)', () => {
        const r = computeTimeToFill([
            { approvedAt: '2026-02-01', acceptedAt: '2026-01-01', category: 'X' },
        ]);
        expect(r.count).toBe(0);
        expect(r.avgDays).toBeNull();
    });

    test('guard: empty input returns nulls, never throws', () => {
        expect(() => computeTimeToFill([])).not.toThrow();
        expect(() => computeTimeToFill()).not.toThrow();
        expect(computeTimeToFill([]).count).toBe(0);
    });

    test('groups by category', () => {
        const r = computeTimeToFill([
            { approvedAt: '2026-01-01', acceptedAt: '2026-01-11', category: 'Eng' },  // 10
            { approvedAt: '2026-01-01', acceptedAt: '2026-01-31', category: 'Ops' },  // 30
        ]);
        const eng = r.byCategory.find(c => c.category === 'Eng');
        const ops = r.byCategory.find(c => c.category === 'Ops');
        expect(eng.avgDays).toBe(10);
        expect(ops.avgDays).toBe(30);
    });
});

// ---------------------------------------------------------------------------
// HR-KPI-05 — Appraisal completion / on-time
// ---------------------------------------------------------------------------
describe('HR-KPI-05 computeAppraisalCompletion', () => {
    test('completion % = finalized / total', () => {
        const r = computeAppraisalCompletion([
            { status: 'FINALIZED', submittedAt: '2026-03-01' },
            { status: 'FINALIZED', submittedAt: '2026-03-02' },
            { status: 'IN_PROGRESS', submittedAt: null },
            { status: 'DRAFT', submittedAt: null },
        ], '2026-03-31');
        expect(r.total).toBe(4);
        expect(r.finalized).toBe(2);
        expect(r.completionRate).toBe(50);
    });

    test('on-time = finalized on/before cycle end / total', () => {
        const r = computeAppraisalCompletion([
            { status: 'FINALIZED', submittedAt: '2026-03-15' }, // on time
            { status: 'FINALIZED', submittedAt: '2026-04-10' }, // late (after end)
            { status: 'IN_PROGRESS', submittedAt: null },       // not finalized
            { status: 'FINALIZED', submittedAt: '2026-03-31' }, // on time (boundary)
        ], '2026-03-31');
        expect(r.finalized).toBe(3);
        expect(r.onTime).toBe(2);
        expect(r.onTimeRate).toBe(50); // 2 of 4 total
    });

    test('guard: empty cycle returns zeros, never throws', () => {
        const r = computeAppraisalCompletion([], '2026-03-31');
        expect(r).toEqual({ total: 0, finalized: 0, completionRate: 0, onTime: 0, onTimeRate: 0 });
    });

    test('guard: missing cycleEnd yields null onTimeRate (no false breach)', () => {
        const r = computeAppraisalCompletion([
            { status: 'FINALIZED', submittedAt: '2026-03-15' },
        ], null);
        expect(r.completionRate).toBe(100);
        expect(r.onTimeRate).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// HR-KPI-06 — Payroll accuracy + on-time
// ---------------------------------------------------------------------------
describe('HR-KPI-06 computePayrollKpis', () => {
    test('accuracy = non-failed / total (cancelled excluded from denominator)', () => {
        const r = computePayrollKpis([
            { status: 'FINALIZED', periodEnd: '2026-01-31', updated_at: '2026-02-02' },
            { status: 'FINALIZED', periodEnd: '2026-02-28', updated_at: '2026-03-02' },
            { status: 'FAILED', periodEnd: '2026-03-31' },
            { status: 'CANCELLED', periodEnd: '2026-04-30' }, // excluded
        ]);
        expect(r.totalRuns).toBe(3); // cancelled excluded
        expect(r.failedRuns).toBe(1);
        // (3 - 1) / 3 = 66.67
        expect(r.accuracyRate).toBeCloseTo(66.67, 1);
    });

    test('on-time = finalized within grace window after periodEnd', () => {
        const r = computePayrollKpis([
            // finalized 2 days after period end -> within default 5-day grace
            { status: 'FINALIZED', periodEnd: '2026-01-31', updated_at: '2026-02-02' },
            // finalized 10 days after -> late
            { status: 'FINALIZED', periodEnd: '2026-02-28', updated_at: '2026-03-10' },
        ], 5);
        expect(r.finalizedRuns).toBe(2);
        expect(r.onTimeRuns).toBe(1);
        expect(r.onTimeRate).toBe(50);
    });

    test('prefers approvedAt/processedAt over updated_at for finalize moment', () => {
        const r = computePayrollKpis([
            {
                status: 'FINALIZED',
                periodEnd: '2026-01-31',
                approvedAt: '2026-02-01', // within grace
                updated_at: '2026-03-01', // would be late, but approvedAt wins
            },
        ], 5);
        expect(r.onTimeRuns).toBe(1);
        expect(r.onTimeRate).toBe(100);
    });

    test('guard: empty input returns null rates, never throws', () => {
        const r = computePayrollKpis([]);
        expect(r.totalRuns).toBe(0);
        expect(r.accuracyRate).toBeNull();
        expect(r.onTimeRate).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// HR-REC-09 — Recruitment funnel
// ---------------------------------------------------------------------------
describe('HR-REC-09 computeRecruitmentFunnel', () => {
    test('computes stage conversions and offer-acceptance rate', () => {
        const r = computeRecruitmentFunnel({
            applied: 100, screened: 60, interviewed: 30, offered: 10, accepted: 8, hired: 8,
        });
        expect(r.conversions.applyToScreen).toBe(60);
        expect(r.conversions.screenToInterview).toBe(50);
        expect(r.conversions.interviewToOffer).toBeCloseTo(33.33, 1);
        expect(r.offerAcceptanceRate).toBe(80); // 8/10
    });

    test('guard: zero offers -> null acceptance rate (no divide-by-zero)', () => {
        const r = computeRecruitmentFunnel({ applied: 5, offered: 0, accepted: 0 });
        expect(r.offerAcceptanceRate).toBeNull();
    });

    test('guard: empty input does not throw', () => {
        expect(() => computeRecruitmentFunnel()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// HR-KPI-07 — KPI targets / out-of-range evaluation
// ---------------------------------------------------------------------------
describe('HR-KPI-07 evaluateKpiTarget(s)', () => {
    test('max-direction KPI breaches when above target', () => {
        const breach = evaluateKpiTarget('timeToFillDays', KPI_TARGETS.timeToFillDays.target + 5);
        expect(breach).not.toBeNull();
        expect(breach.direction).toBe('max');
    });

    test('max-direction KPI does not breach when at/under target', () => {
        expect(evaluateKpiTarget('timeToFillDays', KPI_TARGETS.timeToFillDays.target)).toBeNull();
    });

    test('min-direction KPI breaches when below target', () => {
        const breach = evaluateKpiTarget('payrollAccuracyRate', KPI_TARGETS.payrollAccuracyRate.target - 1);
        expect(breach).not.toBeNull();
        expect(breach.direction).toBe('min');
    });

    test('guard: null value never breaches', () => {
        expect(evaluateKpiTarget('payrollAccuracyRate', null)).toBeNull();
        expect(evaluateKpiTarget('timeToFillDays', undefined)).toBeNull();
    });

    test('evaluateKpiTargets returns only breached KPIs and ignores unknown keys', () => {
        const breaches = evaluateKpiTargets({
            timeToFillDays: 999,       // breach (max)
            payrollAccuracyRate: 100,  // ok (min, at/above)
            notAKpi: 5,                // ignored
        });
        const keys = breaches.map(b => b.kpi);
        expect(keys).toContain('timeToFillDays');
        expect(keys).not.toContain('payrollAccuracyRate');
        expect(keys).not.toContain('notAKpi');
    });
});

// ---------------------------------------------------------------------------
// Service-layer wiring (real prisma rows, mocked client)
// ---------------------------------------------------------------------------
describe('getRecruitmentDashboard (HR-KPI-04 / HR-REC-09) wiring', () => {
    test('computes timeToFill from real requisition/approval/offer rows (not 42)', async () => {
        mockJobRequisitionFindMany.mockResolvedValue([
            {
                id: 1,
                title: 'Backend Engineer',
                status: 'CLOSED',
                updatedAt: new Date('2026-01-05'),
                position: { title: 'Engineer' },
                postings: [],
                approvals: [
                    { status: 'APPROVED', decidedAt: new Date('2026-01-01') },
                ],
                offers: [
                    { status: 'ACCEPTED', respondedAt: new Date('2026-01-21') }, // 20 days
                ],
                applications: [
                    { stage: 'hired', interviews: [{ id: 1 }] },
                ],
            },
        ]);

        const result = await getRecruitmentDashboard({ tenantId: 't', timeframe: 'current_quarter', userRole: 'HR_ADMIN' });

        expect(result.timeToFill.avgDays).toBe(20);
        expect(result.timeToFill.count).toBe(1);
        expect(result.timeToFill.byCategory[0].category).toBe('Engineer');
        // recruitment funnel present and data-driven
        expect(result.recruitmentFunnel.offerAcceptanceRate).toBe(100);
        // no longer the hardcoded scalar
        expect(result.timeToFill).not.toBe(42);
    });

    test('handles no-filled-requisitions without throwing (null avgDays)', async () => {
        mockJobRequisitionFindMany.mockResolvedValue([
            {
                id: 2, title: 'Open Role', status: 'POSTED', updatedAt: new Date(),
                position: { title: 'Engineer' }, postings: [], approvals: [],
                offers: [], applications: [],
            },
        ]);
        const result = await getRecruitmentDashboard({ tenantId: 't', timeframe: 'current_quarter', userRole: 'HR_ADMIN' });
        expect(result.timeToFill.avgDays).toBeNull();
        expect(result.timeToFill.count).toBe(0);
    });
});

describe('getPerformanceDashboard (HR-KPI-05) wiring', () => {
    test('computes completion % and on-time % per cycle from real reviews', async () => {
        mockPerformanceReviewFindMany.mockResolvedValue([
            { status: 'FINALIZED', submittedAt: new Date('2026-03-15'), overall_rating: 4, cycleId: 1, cycle: { id: 1, name: 'Q1', end_date: new Date('2026-03-31') } },
            { status: 'FINALIZED', submittedAt: new Date('2026-04-10'), overall_rating: 3, cycleId: 1, cycle: { id: 1, name: 'Q1', end_date: new Date('2026-03-31') } }, // late
            { status: 'IN_PROGRESS', submittedAt: new Date('2026-03-20'), overall_rating: null, cycleId: 1, cycle: { id: 1, name: 'Q1', end_date: new Date('2026-03-31') } },
        ]);

        const result = await getPerformanceDashboard({ tenantId: 't', timeframe: 'current_quarter', userRole: 'HR_ADMIN' });

        // 2 finalized of 3 total -> 66.67
        expect(result.completionRate).toBeCloseTo(66.67, 1);
        // 1 of 3 on time -> 33.33
        expect(result.onTimeCompletionRate).toBeCloseTo(33.33, 1);
        expect(result.byCycle[0].cycleName).toBe('Q1');
        expect(result.byCycle[0].completionRate).toBeCloseTo(66.67, 1);
    });
});

describe('getPayrollKpis (HR-KPI-06) wiring', () => {
    test('computes accuracy + on-time from real PayrollRun rows', async () => {
        mockPayrollRunFindMany.mockResolvedValue([
            { id: 1, status: 'FINALIZED', periodEnd: new Date('2026-01-31'), approvedAt: new Date('2026-02-02'), processedAt: new Date('2026-02-01'), updated_at: new Date('2026-02-02') },
            { id: 2, status: 'FINALIZED', periodEnd: new Date('2026-02-28'), approvedAt: new Date('2026-03-12'), processedAt: new Date('2026-03-11'), updated_at: new Date('2026-03-12') }, // late
            { id: 3, status: 'FAILED', periodEnd: new Date('2026-03-31'), approvedAt: null, processedAt: null, updated_at: new Date('2026-04-01') },
        ]);

        const result = await getPayrollKpis({ tenantId: 't', timeframe: 'current_quarter', userRole: 'HR_ADMIN' });

        expect(result.totalRuns).toBe(3);
        expect(result.failedRuns).toBe(1);
        expect(result.accuracyRate).toBeCloseTo(66.67, 1);
        expect(result.finalizedRuns).toBe(2);
        expect(result.onTimeRuns).toBe(1);
        expect(result.onTimeRate).toBe(50);
    });
});

describe('generateEEOReport (HR-ANL-02) wiring', () => {
    test('exposes gender + nationality + ageGroup from real Employee columns', async () => {
        mockEmployeeFindMany.mockResolvedValue([
            { gender: 'FEMALE', nationality: 'PK', date_of_birth: new Date('1990-01-01'), hire_date: new Date('2024-01-01'), Position: { title: 'Engineer' } },
            { gender: 'MALE', nationality: 'US', date_of_birth: new Date('1980-01-01'), hire_date: new Date('2023-01-01'), Position: { title: 'Engineer' } },
        ]);

        const result = await generateEEOReport({ tenantId: 't', userRole: 'HR_ADMIN' });
        const pos = result[0];
        const cats = Object.keys(pos.demographics);
        expect(cats).toEqual(expect.arrayContaining(['gender', 'nationality', 'ageGroup', 'yearsOfService']));
        expect(pos.totalEmployees).toBe(2);
        expect(typeof pos.diversityIndex).toBe('number');
        // nationality counts derived from real column
        const natGroups = pos.demographics.nationality.map(n => n.group);
        expect(natGroups).toEqual(expect.arrayContaining(['PK', 'US']));
    });
});
