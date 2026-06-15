// tests/unit/integration/training.integration.test.js
//
// Deferred: this suite imports a full Express `app` from `src/app.js` and
// exercises the real `/api/training` routes via supertest. There is no
// `src/app.js` in this repo today (the bootstrap lives in `src/server.js`
// which does not export the app), and the routes hit Prisma against the
// `erp-hr` database which is intentionally absent in the unit lane.
//
// Reviving this suite is part of the P2 outbox / route-shape work; until
// then we keep the intent visible via describe.skip so the file remains
// runnable under Jest and the gate stays honest.
import { describe, it, expect } from '@jest/globals';

describe.skip('Training API Integration Tests (deferred: needs src/app.js + db)', () => {
    it('placeholder', () => {
        expect(true).toBe(true);
    });
});
