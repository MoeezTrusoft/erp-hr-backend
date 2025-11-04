// tests/unit/trainingController.test.js
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock the training service directly in this file
const mockCreateCourse = jest.fn();
const mockGetCourses = jest.fn();
const mockGetCourseById = jest.fn();
const mockUpdateCourse = jest.fn();
const mockDeleteCourse = jest.fn();
const mockCreateCategory = jest.fn();
const mockGetCategories = jest.fn();

jest.unstable_mockModule('../../src/services/trainingService.js', () => ({
    createCourse: mockCreateCourse,
    getCourses: mockGetCourses,
    getCourseById: mockGetCourseById,
    updateCourse: mockUpdateCourse,
    deleteCourse: mockDeleteCourse,
    createCategory: mockCreateCategory,
    getCategories: mockGetCategories
}));

describe('Training Controller Unit Tests', () => {
    let trainingController;
    let trainingService;

    beforeEach(async () => {
        // Clear all mocks
        mockCreateCourse.mockClear();
        mockGetCourses.mockClear();
        mockGetCourseById.mockClear();
        mockUpdateCourse.mockClear();
        mockDeleteCourse.mockClear();
        mockCreateCategory.mockClear();
        mockGetCategories.mockClear();

        // Import after mocks are set up
        trainingController = await import('../../src/controllers/trainingController.js');
        trainingService = await import('../../src/services/trainingService.js');
    });

    describe('createCourse', () => {
        it('should return 201 when course created successfully', async () => {
            const mockReq = {
                body: {
                    title: 'New Course',
                    categoryId: 1
                }
            };

            const mockRes = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn()
            };

            const mockCourse = {
                id: 1,
                title: 'New Course',
                categoryId: 1
            };

            trainingService.createCourse.mockResolvedValue(mockCourse);

            await trainingController.createCourse(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(201);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: true,
                message: 'Course created successfully',
                data: mockCourse
            });
        });

        it('should return 400 when service throws error', async () => {
            const mockReq = {
                body: { title: 'Test' }
            };

            const mockRes = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn()
            };

            trainingService.createCourse.mockRejectedValue(new Error('Validation error'));

            await trainingController.createCourse(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(400);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: false,
                message: 'Validation error'
            });
        });
    });

    describe('getCourse', () => {
        it('should return 200 with course data', async () => {
            const mockReq = {
                params: { id: '1' }
            };

            const mockRes = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn()
            };

            const mockCourse = { id: 1, title: 'Test Course' };
            trainingService.getCourseById.mockResolvedValue(mockCourse);

            await trainingController.getCourse(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: true,
                message: 'Course fetched successfully',
                data: mockCourse
            });
        });

        it('should return 404 when course not found', async () => {
            const mockReq = {
                params: { id: '999' }
            };

            const mockRes = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn()
            };

            trainingService.getCourseById.mockRejectedValue(new Error('Course not found'));

            await trainingController.getCourse(mockReq, mockRes);

            expect(mockRes.status).toHaveBeenCalledWith(404);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: false,
                message: 'Course not found'
            });
        });
    });
});