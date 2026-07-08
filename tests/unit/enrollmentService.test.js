// tests/unit/enrollmentService.test.js
//
// The production enrollmentService now imports the shared Prisma client
// from src/lib/prisma.js (per BE-§7.1, P1B singleton work), so we can
// substitute it with jest.unstable_mockModule before importing the
// service. The original suite was parked behind describe.skip while the
// service still ran `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })`; we now revive its intent.
//
// We also stub src/utils/logs.js so the audit-log side-effect doesn't
// reach the real prisma client during these unit tests.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockFindFirst = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockFindMany = jest.fn();
const mockCount = jest.fn();
const mockTransaction = jest.fn();
const mockLogAction = jest.fn();

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
    default: {
        trainingEnrollment: {
            findFirst: mockFindFirst,
            create: mockCreate,
            update: mockUpdate,
            findMany: mockFindMany,
            count: mockCount,
        },
        trainingCourse: {
            findMany: mockFindMany,
        },
        $transaction: mockTransaction,
    },
}));

jest.unstable_mockModule('../../src/utils/logs.js', () => ({
    logAction: mockLogAction,
}));

const enrollmentService = await import('../../src/services/enrollmentService.js');

describe('Enrollment Service module surface (smoke)', () => {
    it('exposes the documented entry points', () => {
        expect(typeof enrollmentService.enrollUser).toBe('function');
        expect(typeof enrollmentService.bulkEnrollUsers).toBe('function');
        expect(typeof enrollmentService.updateProgress).toBe('function');
        expect(typeof enrollmentService.getEmployeeTranscript).toBe('function');
    });
});

describe('Enrollment Service Unit Tests', () => {
    beforeEach(() => {
        mockFindFirst.mockReset();
        mockCreate.mockReset();
        mockUpdate.mockReset();
        mockFindMany.mockReset();
        mockCount.mockReset();
        mockTransaction.mockReset();
        mockLogAction.mockReset();
        mockLogAction.mockResolvedValue(undefined);
    });

    describe('enrollUser', () => {
        it('should enroll user successfully', async () => {
            const enrollmentData = { courseId: 1, employeeId: 1 };
            const mockEnrollment = {
                id: 1,
                ...enrollmentData,
                status: 'ENROLLED',
                enrollmentDate: new Date(),
            };

            mockFindFirst.mockResolvedValue(null);
            mockCreate.mockResolvedValue(mockEnrollment);

            const result = await enrollmentService.enrollUser(enrollmentData, 99);

            expect(mockFindFirst).toHaveBeenCalledWith({
                where: {
                    courseId: 1,
                    employeeId: 1,
                    status: { in: ['ENROLLED', 'IN_PROGRESS'] },
                },
            });
            expect(result).toEqual(mockEnrollment);
            expect(mockLogAction).toHaveBeenCalledTimes(1);
        });

        // The service wraps every error in `Failed to enroll user: …`; the
        // substring matchers below stay readable while still asserting the
        // root cause.
        it('should throw error when user already enrolled', async () => {
            mockFindFirst.mockResolvedValue({ id: 1 });

            await expect(
                enrollmentService.enrollUser({ courseId: 1, employeeId: 1 })
            ).rejects.toThrow('User is already enrolled in this course');
        });

        it('should throw error when required fields missing', async () => {
            await expect(enrollmentService.enrollUser({})).rejects.toThrow(
                'Course ID and Employee ID are required'
            );
        });
    });

    describe('bulkEnrollUsers', () => {
        it('should bulk enroll users successfully', async () => {
            const mockEnrollments = [
                { id: 1, courseId: 1, employeeId: 1, status: 'ENROLLED' },
                { id: 2, courseId: 1, employeeId: 2, status: 'ENROLLED' },
                { id: 3, courseId: 1, employeeId: 3, status: 'ENROLLED' },
            ];

            // The service calls `prisma.$transaction(arrayOfCreatePromises)`,
            // not the callback overload. Resolve the array of promises so
            // the mock matches real Prisma semantics.
            mockTransaction.mockImplementation((ops) => {
                if (Array.isArray(ops)) return Promise.all(ops);
                return ops(/* tx */);
            });
            mockCreate
                .mockResolvedValueOnce(mockEnrollments[0])
                .mockResolvedValueOnce(mockEnrollments[1])
                .mockResolvedValueOnce(mockEnrollments[2]);

            const result = await enrollmentService.bulkEnrollUsers(1, [1, 2, 3], 99);

            expect(mockTransaction).toHaveBeenCalledTimes(1);
            expect(mockCreate).toHaveBeenCalledTimes(3);
            expect(result).toHaveLength(3);
            expect(mockLogAction).toHaveBeenCalledTimes(1);
        });

        it('should reject when employeeIds is not an array', async () => {
            await expect(
                enrollmentService.bulkEnrollUsers(1, 'not-an-array', 99)
            ).rejects.toThrow('Course ID and Employee IDs array are required');
        });
    });

    describe('updateProgress', () => {
        it('should update progress and mark as completed at 100%', async () => {
            const mockEnrollment = {
                id: 1,
                progress: 100,
                status: 'COMPLETED',
            };

            mockUpdate.mockResolvedValue(mockEnrollment);

            const result = await enrollmentService.updateProgress(1, 100, 99);

            expect(mockUpdate).toHaveBeenCalledWith({
                where: { id: 1 },
                data: {
                    progress: 100,
                    status: 'COMPLETED',
                },
                include: expect.any(Object),
            });
            expect(result.status).toBe('COMPLETED');
            expect(mockLogAction).toHaveBeenCalledTimes(1);
        });

        it('should update progress and keep as in progress below 100%', async () => {
            const mockEnrollment = {
                id: 1,
                progress: 75,
                status: 'IN_PROGRESS',
            };

            mockUpdate.mockResolvedValue(mockEnrollment);

            const result = await enrollmentService.updateProgress(1, 75, 99);

            expect(result.status).toBe('IN_PROGRESS');
            expect(result.progress).toBe(75);
        });

        // The service catches Prisma's P2025 ("record not found") code and
        // surfaces a friendly "Enrollment not found" message — assert that
        // pathway here so it can't regress silently.
        it('should translate Prisma P2025 to a not-found error', async () => {
            const err = Object.assign(new Error('not found'), { code: 'P2025' });
            mockUpdate.mockRejectedValue(err);

            await expect(
                enrollmentService.updateProgress(1, 50, 99)
            ).rejects.toThrow('Enrollment not found');
        });
    });

    describe('getEmployeeTranscript', () => {
        it('should return employee transcript', async () => {
            const mockEnrollments = [
                {
                    id: 1,
                    status: 'COMPLETED',
                    completionDate: new Date(),
                    course: {
                        id: 1,
                        title: 'Completed Course',
                        category: { name: 'Technical' },
                    },
                },
            ];

            mockFindMany.mockResolvedValue(mockEnrollments);

            const result = await enrollmentService.getEmployeeTranscript(1);

            expect(mockFindMany).toHaveBeenCalledWith({
                where: {
                    employeeId: 1,
                    status: 'COMPLETED',
                },
                include: expect.any(Object),
                orderBy: { completionDate: 'desc' },
            });
            expect(result).toEqual(mockEnrollments);
        });

        it('should reject when employeeId is missing', async () => {
            await expect(
                enrollmentService.getEmployeeTranscript(undefined)
            ).rejects.toThrow('Employee ID is required');
        });
    });
});
