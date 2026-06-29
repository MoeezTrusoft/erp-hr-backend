// tests/unit/integration/training.integration.test.js
//
// The original suite imported a full Express `app` from `src/app.js` and
// exercised real /api/training routes against the erp-hr database. Neither
// `src/app.js` (no app export — bootstrap lives in `src/server.js`) nor a
// test database exists in this unit lane, so the file was parked behind
// describe.skip pending the P2 outbox / route-shape work.
//
// We restore route-layer coverage on the same ESM mocking pattern used by
// analyticsRoutes.test.js (P1E): mount `trainingRoutes` on a minimal
// express app, mock the service layer with jest.unstable_mockModule, and
// assert what the historical suite intended — route wiring, an unknown
// route producing 404, and validation errors from the service surfacing
// as 400 — without depending on a real app handle or DB connection.
//
// No production source is touched in this lane.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockCreateCourse = jest.fn();
const mockGetCourses = jest.fn();
const mockGetCourseById = jest.fn();
const mockUpdateCourse = jest.fn();
const mockDeleteCourse = jest.fn();
const mockCreateCategory = jest.fn();
const mockGetCategories = jest.fn();

const mockEnrollUser = jest.fn();
const mockBulkEnrollUsers = jest.fn();
const mockGetUserEnrollments = jest.fn();
const mockGetCourseEnrollments = jest.fn();
const mockUpdateEnrollmentStatus = jest.fn();
const mockUpdateProgress = jest.fn();
const mockCancelEnrollment = jest.fn();
const mockGetEmployeeTranscript = jest.fn();
const mockGetComplianceStatus = jest.fn();

// Controllers use `import * as trainingService` / `import * as enrollmentService`,
// so the mock must provide every named export that either module uses to
// avoid "is not a function" errors against unrelated routes loaded by the
// router.
jest.unstable_mockModule('../../../src/services/trainingService.js', () => ({
    createCourse: mockCreateCourse,
    getCourses: mockGetCourses,
    getCourseById: mockGetCourseById,
    updateCourse: mockUpdateCourse,
    deleteCourse: mockDeleteCourse,
    createCategory: mockCreateCategory,
    getCategories: mockGetCategories,
}));

jest.unstable_mockModule('../../../src/services/enrollmentService.js', () => ({
    enrollUser: mockEnrollUser,
    bulkEnrollUsers: mockBulkEnrollUsers,
    getUserEnrollments: mockGetUserEnrollments,
    getCourseEnrollments: mockGetCourseEnrollments,
    updateEnrollmentStatus: mockUpdateEnrollmentStatus,
    updateProgress: mockUpdateProgress,
    cancelEnrollment: mockCancelEnrollment,
    getEmployeeTranscript: mockGetEmployeeTranscript,
    getComplianceStatus: mockGetComplianceStatus,
}));

const { default: trainingRoutes } = await import('../../../src/routes/trainingRoutes.js');

const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/api/training', trainingRoutes);
    return app;
};

describe('Training API Integration Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Route wiring', () => {
        test('GET /api/training/courses returns the service result wrapped in the standard envelope', async () => {
            const mockResult = {
                data: [
                    { id: 1, title: 'Onboarding 101', mode: 'ONLINE' },
                    { id: 2, title: 'Security Basics', mode: 'IN_PERSON' },
                ],
                meta: { total: 2 },
            };
            mockGetCourses.mockResolvedValue(mockResult);

            const response = await request(buildApp())
                .get('/api/training/courses')
                .query({ status: 'ACTIVE' });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.message).toBe('Courses fetched successfully');
            expect(response.body.data).toEqual(mockResult);
            expect(mockGetCourses).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'ACTIVE' })
            );
        });

        test('GET /api/training/categories returns the service result', async () => {
            const mockCategories = [
                { id: 1, name: 'Compliance' },
                { id: 2, name: 'Technical' },
            ];
            mockGetCategories.mockResolvedValue(mockCategories);

            const response = await request(buildApp())
                .get('/api/training/categories');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data).toEqual(mockCategories);
            expect(mockGetCategories).toHaveBeenCalledTimes(1);
        });

        test('GET on an unknown route under /api/training falls through to Express 404', async () => {
            const response = await request(buildApp())
                .get('/api/training/unknown-route');

            expect(response.status).toBe(404);
            // None of the wired handlers should have been invoked for an
            // unmatched path.
            expect(mockGetCourses).not.toHaveBeenCalled();
            expect(mockGetCourseById).not.toHaveBeenCalled();
        });
    });

    describe('Request validation surface', () => {
        test('POST /api/training/courses with invalid payload surfaces the service error as 400', async () => {
            mockCreateCourse.mockRejectedValue(new Error('title is required'));

            const response = await request(buildApp())
                .post('/api/training/courses')
                .set('employee-id', '7')
                .send({ description: 'no title here' });

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.message).toBe('title is required');
            // Controller forwards the body and employee-id header to the service.
            expect(mockCreateCourse).toHaveBeenCalledWith(
                { description: 'no title here' },
                '7'
            );
        });

        test('GET /api/training/courses/:id returns 404 when the service reports the course missing', async () => {
            mockGetCourseById.mockRejectedValue(new Error('Course not found'));

            const response = await request(buildApp())
                .get('/api/training/courses/999');

            expect(response.status).toBe(404);
            expect(response.body.success).toBe(false);
            expect(response.body.message).toBe('Course not found');
            // C.2-completion: the controller now also forwards the verified
            // tenant (req.user.tenantId) as a trailing arg — undefined here since
            // the test app sets no service-JWT tenant claim.
            expect(mockGetCourseById).toHaveBeenCalledWith('999', undefined);
        });

        test('POST /api/training/enrollments surfaces enrollment service validation as 400', async () => {
            mockEnrollUser.mockRejectedValue(new Error('Employee already enrolled'));

            const response = await request(buildApp())
                .post('/api/training/enrollments')
                .set('employee-id', '7')
                .send({ courseId: 1, employeeId: 7 });

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.message).toBe('Employee already enrolled');
            expect(mockEnrollUser).toHaveBeenCalledWith(
                { courseId: 1, employeeId: 7 },
                '7'
            );
        });
    });
});
