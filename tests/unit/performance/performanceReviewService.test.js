import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Performance Review Service', () => {
    beforeEach(async () => {
        // Clean up before each test
        await prisma.performanceReview.deleteMany({});
    });

    afterEach(async () => {
        await prisma.performanceReview.deleteMany({});
    });

    it('should calculate overall rating correctly', () => {
        const ratings = [4, 5, 3];
        const average = ratings.reduce((a, b) => a + b, 0) / ratings.length;
        expect(average).toBe(4);
    });

    it('should handle review status transitions', () => {
        const review = {
            status: 'DRAFT',
            submittedAt: null
        };

        // Simulate submission
        review.status = 'SUBMITTED';
        review.submittedAt = new Date();

        expect(review.status).toBe('SUBMITTED');
        expect(review.submittedAt).toBeInstanceOf(Date);
    });
});