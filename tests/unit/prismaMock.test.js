// tests/unit/prismaMock.test.js
import { describe, it, expect, jest } from '@jest/globals';

// Mock Prisma first
jest.unstable_mockModule('../../src/config/prisma.js', () => ({
    default: {
        trainingCourse: {
            create: jest.fn().mockResolvedValue({ id: 1, title: 'Mock Course' }),
            findUnique: jest.fn().mockResolvedValue({ id: 1, title: 'Mock Course' })
        }
    }
}));

describe('Prisma Mock Test', () => {
    it('should use mocked Prisma', async () => {
        const prisma = (await import('../../src/config/prisma.js')).default;
        const trainingService = await import('../../src/services/trainingService.js');

        // Test that the mock is working
        const result = await prisma.trainingCourse.create();
        expect(result).toEqual({ id: 1, title: 'Mock Course' });
    });
});