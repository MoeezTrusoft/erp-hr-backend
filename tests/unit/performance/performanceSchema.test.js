// tests/unit/performance/performanceSchema.test.js — PERF-P0 (E-04).
//
// The zod boundary for the legacy performance payloads: strict objects, date
// ordering, rating bounds, camelCase→snake_case cycle normalisation, and the
// template criteria weight rule. Replaces the former inline-mock placeholders.
import { describe, it, expect } from '@jest/globals';

import {
    CYCLE_TRANSITIONS,
    calibrationAdjustSchema,
    cycleCreateSchema,
    cycleUpdateSchema,
    goalAlignmentCreateSchema,
    goalProgressSchema,
    goalUpdateSchema,
    initiateReviewsSchema,
    parsePerformancePayload,
    reviewCreateSchema,
    reviewUpdateSchema,
    templateCreateSchema,
} from '../../../src/validators/performance.schema.js';

const reject = (schema, payload) => {
    try {
        parsePerformancePayload(schema, payload);
    } catch (e) {
        return e;
    }
    throw new Error('expected rejection');
};

describe('performance payload schemas', () => {
    it('review create coerces ids, orders the period and rejects unknown keys', () => {
        const ok = parsePerformancePayload(reviewCreateSchema, {
            employeeId: '7', reviewerId: 8, period_start: '2026-01-01', period_end: '2026-06-30', reviewType: 'MANAGER',
        });
        expect(ok).toMatchObject({ employeeId: 7, reviewerId: 8, reviewType: 'MANAGER' });
        const e = reject(reviewCreateSchema, { employeeId: 7, period_start: '2026-06-30', period_end: '2026-01-01' });
        expect(e.status).toBe(400);
        expect(e.code).toBe('HR-4000');
        expect(e.details.fieldErrors[0].path).toBe('period_end');
        expect(reject(reviewCreateSchema, { employeeId: 7, period_start: '2026-01-01', period_end: '2026-02-01', createdById: 1 }).status).toBe(400);
    });

    it('review update never accepts a status (E-02) and bounds the rating', () => {
        expect(parsePerformancePayload(reviewUpdateSchema, { overallRating: 4.5, comments: 'ok' })).toEqual({ overallRating: 4.5, comments: 'ok' });
        expect(reject(reviewUpdateSchema, { status: 'FINALIZED' }).status).toBe(400);
        expect(reject(reviewUpdateSchema, { overallRating: 7 }).status).toBe(400);
    });

    it('bulk initiate requires at least one employee id', () => {
        expect(parsePerformancePayload(initiateReviewsSchema, { cycleId: 3, employeeIds: ['1', 2] })).toEqual({ cycleId: 3, employeeIds: [1, 2] });
        expect(reject(initiateReviewsSchema, { cycleId: 3, employeeIds: [] }).status).toBe(400);
    });

    it('goal update accepts percent progress and expectedVersion; progress notes are 0..100', () => {
        expect(parsePerformancePayload(goalUpdateSchema, { progress: '40', expectedVersion: 2 })).toEqual({ progress: 40, expectedVersion: 2 });
        expect(reject(goalUpdateSchema, { progress: 140 }).status).toBe(400);
        expect(reject(goalProgressSchema, { goalId: 1, progress: -1 }).status).toBe(400);
        expect(reject(goalAlignmentCreateSchema, { parentGoalId: 1, alignedGoalId: 1 }).status).toBe(400);
    });

    it('cycle create normalises the MCP camelCase dates and defaults nothing silently', () => {
        const fromTool = parsePerformancePayload(cycleCreateSchema, { name: 'FY26', startDate: '2026-01-01', endDate: '2026-12-31' });
        expect(fromTool).toEqual({ name: 'FY26', start_date: '2026-01-01', end_date: '2026-12-31' });
        const fromRest = parsePerformancePayload(cycleCreateSchema, { name: 'FY26', start_date: '2026-01-01', end_date: '2026-12-31', templateId: '2', status: 'ACTIVE' });
        expect(fromRest).toMatchObject({ templateId: 2, status: 'ACTIVE' });
        expect(reject(cycleCreateSchema, { name: 'FY26', startDate: '2026-12-31', endDate: '2026-01-01' }).status).toBe(400);
        expect(reject(cycleCreateSchema, { name: 'FY26', startDate: '2026-01-01', endDate: '2026-12-31', status: 'CLOSED' }).status).toBe(400);
        expect(reject(cycleCreateSchema, { name: 'FY26' }).status).toBe(400);
        expect(parsePerformancePayload(cycleUpdateSchema, { status: 'CLOSED' })).toEqual({ status: 'CLOSED' });
    });

    it('cycle transitions are DRAFT → ACTIVE → CLOSED only', () => {
        expect(CYCLE_TRANSITIONS).toEqual({ DRAFT: ['ACTIVE'], ACTIVE: ['CLOSED'], CLOSED: [] });
    });

    it('template criteria accept labels or weighted objects whose weights sum to 100', () => {
        expect(parsePerformancePayload(templateCreateSchema, { name: 'T', criteria: ['Goals', 'Values'] }).criteria).toHaveLength(2);
        expect(parsePerformancePayload(templateCreateSchema, { name: 'T', criteria: [{ name: 'Goals', weight: 60 }, { name: 'Values', weight: 40 }] }).criteria).toHaveLength(2);
        expect(reject(templateCreateSchema, { name: 'T', criteria: [{ name: 'Goals', weight: 60 }, { name: 'Values', weight: 30 }] }).message).toMatch(/sum to 100/);
        expect(reject(templateCreateSchema, { name: 'T', criteria: [{ name: 'Goals', weight: 100 }, { name: 'Values' }] }).message).toMatch(/every criterion/);
    });

    it('calibration adjustment bounds both ratings and allows an explicit session', () => {
        expect(parsePerformancePayload(calibrationAdjustSchema, { reviewId: '4', old_rating: 2, new_rating: 3, calibrationSessionId: '9' })).toEqual({ reviewId: 4, old_rating: 2, new_rating: 3, calibrationSessionId: 9 });
        expect(reject(calibrationAdjustSchema, { reviewId: 4, old_rating: 2, new_rating: 6 }).status).toBe(400);
    });
});
