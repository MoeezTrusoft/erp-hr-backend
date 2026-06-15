// Smoke check that the analytics service module still loads and exposes a
// non-empty surface. The original file was a debug script (console.log only)
// with no assertions, which caused Jest to fail with "Your test suite must
// contain at least one test".
import { describe, it, expect } from '@jest/globals';
import * as analyticsService from '../src/services/analyticsService.js';

describe('analyticsService export surface (smoke)', () => {
    it('exposes at least one named export', () => {
        const keys = Object.keys(analyticsService);
        expect(keys.length).toBeGreaterThan(0);
    });

    it('exposes the historical applyDataScope helper', () => {
        expect(typeof analyticsService.applyDataScope).toBe('function');
    });
});
