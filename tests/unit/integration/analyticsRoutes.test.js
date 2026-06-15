// tests/unit/integration/analyticsRoutes.test.js
//
// Deferred: this suite predates the ESM migration. It uses the legacy
// `jest.mock(...)` helper (which is a no-op against ESM modules under
// `--experimental-vm-modules`) and pokes Express 5 internals
// (`app._router.stack[1].handle`) that no longer exist. The substantive
// coverage it provides — analytics routes wired to the controller with a
// mocked service — is duplicated by `analytics.integration.test.js` in
// the same directory, which already uses `jest.unstable_mockModule`.
//
// Keeping the file as a documented skip preserves the historical intent
// without falsely advertising coverage. A follow-up can either delete it
// once stakeholders confirm, or rewrite it on top of the ESM mocking
// pattern used by the sibling file.
import { describe, it, expect } from '@jest/globals';

describe.skip('Analytics Routes Integration Tests (deferred: superseded by analytics.integration.test.js)', () => {
    it('placeholder', () => {
        expect(true).toBe(true);
    });
});
