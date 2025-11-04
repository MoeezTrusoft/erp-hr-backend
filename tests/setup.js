// tests/setup.js
import { jest } from '@jest/globals';

// Global test timeout
jest.setTimeout(30000);

// Create mock functions
const mockCreate = jest.fn();
const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockCount = jest.fn();
const mockFindFirst = jest.fn();
const mockTransaction = jest.fn();

// Mock Prisma client - use relative path from setup.js location
jest.unstable_mockModule('../src/config/prisma.js', () => ({
    default: {
        trainingCourse: {
            create: mockCreate,
            findMany: mockFindMany,
            findUnique: mockFindUnique,
            update: mockUpdate,
            delete: mockDelete,
            count: mockCount
        },
        trainingCategory: {
            create: mockCreate,
            findMany: mockFindMany
        },
        trainingEnrollment: {
            create: mockCreate,
            findMany: mockFindMany,
            findFirst: mockFindFirst,
            update: mockUpdate,
            delete: mockDelete,
            count: mockCount
        },
        employee: {
            create: mockCreate,
            findMany: mockFindMany,
            findUnique: mockFindUnique
        },
        $transaction: mockTransaction
    }
}));

// Export the mock functions so tests can use them
export {
    mockCreate,
    mockFindMany,
    mockFindUnique,
    mockUpdate,
    mockDelete,
    mockCount,
    mockFindFirst,
    mockTransaction
};