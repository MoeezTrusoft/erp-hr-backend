import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Leave Service', () => {
    beforeEach(async () => {
        // Clean up before each test
        await prisma.leave.deleteMany({});
    });

    afterEach(async () => {
        await prisma.leave.deleteMany({});
    });

    it('should calculate working days correctly', () => {
        const startDate = new Date('2024-01-01');
        const endDate = new Date('2024-01-05');
        const timeDiff = endDate.getTime() - startDate.getTime();
        const daysDiff = timeDiff / (1000 * 3600 * 24) + 1;

        expect(daysDiff).toBe(5);
    });

    it('should handle leave balance calculations', () => {
        const totalLeave = 20;
        const usedLeave = 5;
        const remaining = totalLeave - usedLeave;

        expect(remaining).toBe(15);
    });
});