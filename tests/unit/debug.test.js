// tests/unit/debug.test.js
import { describe, it, expect, jest } from '@jest/globals';

describe('Debug Test', () => {
    it('should show if mocks are working', async () => {
        // Create a simple mock
        const mockFn = jest.fn().mockResolvedValue('mocked result');

        const result = await mockFn();
        expect(result).toBe('mocked result');
        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should test basic Jest functionality', () => {
        expect(1 + 1).toBe(2);
    });
});