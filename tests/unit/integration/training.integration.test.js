// tests/integration/training.integration.test.js
import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import { app } from '../../src/app.js';

describe('Training API Integration Tests', () => {
    describe('Health Check', () => {
        it('should return service health status', async () => {
            const response = await request(app)
                .get('/health')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.message).toBeDefined();
        });
    });

    describe('API Routes', () => {
        it('should return 200 for courses endpoint', async () => {
            const response = await request(app)
                .get('/api/training/courses')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data).toBeDefined();
        });

        it('should return 404 for unknown routes', async () => {
            const response = await request(app)
                .get('/api/training/unknown-route')
                .expect(404);

            expect(response.body.success).toBe(false);
        });
    });

    describe('Request Validation', () => {
        it('should validate course creation request', async () => {
            const invalidCourseData = {
                // Missing required fields
                description: 'Test description'
            };

            const response = await request(app)
                .post('/api/training/courses')
                .send(invalidCourseData)
                .expect(400);

            expect(response.body.success).toBe(false);
        });
    });
});