// tests/performance/training.performance.test.js
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import app from '../../src/server.js';
import prisma from '../../src/config/prisma.js';

describe('Training Module Performance Tests', () => {
    const BATCH_SIZE = 100;

    beforeAll(async () => {
        // Create test category
        await prisma.trainingCategory.create({
            data: {
                name: 'Performance Test Category',
                description: 'For performance testing'
            }
        });
    });

    afterAll(async () => {
        await prisma.trainingEnrollment.deleteMany();
        await prisma.trainingCourse.deleteMany();
        await prisma.trainingCategory.deleteMany();
        await prisma.employee.deleteMany();
    });

    it('should handle bulk course creation efficiently', async () => {
        const startTime = Date.now();

        // Create multiple courses
        const promises = Array.from({ length: BATCH_SIZE }, (_, i) =>
            request(app)
                .post('/api/training/courses')
                .send({
                    title: `Performance Course ${i}`,
                    categoryId: 1,
                    mode: 'ONLINE'
                })
        );

        const responses = await Promise.all(promises);
        const endTime = Date.now();

        // All requests should succeed
        responses.forEach(response => {
            expect(response.status).toBe(201);
        });

        // Should complete within reasonable time (e.g., 10 seconds for 100 requests)
        expect(endTime - startTime).toBeLessThan(10000);
    });

    it('should handle concurrent enrollments efficiently', async () => {
        // Create a test course
        const course = await prisma.trainingCourse.create({
            data: {
                title: 'Concurrent Enrollment Test',
                categoryId: 1,
                status: 'ACTIVE'
            }
        });

        // Create test employees
        const employees = await Promise.all(
            Array.from({ length: 50 }, (_, i) =>
                prisma.employee.create({
                    data: {
                        first_name: `Concurrent${i}`,
                        last_name: 'Test',
                        job_title: 'Tester',
                        hire_date: new Date(),
                        status: 'active'
                    }
                })
            )
        );

        const startTime = Date.now();

        // Attempt concurrent enrollments
        const enrollmentPromises = employees.map(employee =>
            request(app)
                .post('/api/training/enrollments')
                .send({
                    courseId: course.id,
                    employeeId: employee.id
                })
        );

        const responses = await Promise.all(enrollmentPromises);
        const endTime = Date.now();

        // All enrollments should succeed
        responses.forEach(response => {
            expect(response.status).toBe(201);
        });

        // Should handle 50 concurrent enrollments efficiently
        expect(endTime - startTime).toBeLessThan(5000);
    });
});