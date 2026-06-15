// tests/unit/lib/prisma.singleton.test.js
//
// Covers BE-§7.1 obligation: there is one PrismaClient in the HR
// service. Re-importing src/lib/prisma.js (and src/config/prisma.js,
// which re-exports it) must always return the same client instance,
// and the legacy `../config/prisma.js` path must resolve to the same
// object as the new `../lib/prisma.js` path.
import { describe, it, expect } from '@jest/globals';

describe('prisma singleton (BE-§7.1)', () => {
    it('returns the same instance on repeated imports of src/lib/prisma.js', async () => {
        const first = (await import('../../../src/lib/prisma.js')).default;
        const second = (await import('../../../src/lib/prisma.js')).default;

        expect(first).toBeDefined();
        expect(second).toBe(first);
    });

    it('legacy src/config/prisma.js re-exports the same instance', async () => {
        const fromLib = (await import('../../../src/lib/prisma.js')).default;
        const fromConfig = (await import('../../../src/config/prisma.js')).default;

        expect(fromConfig).toBe(fromLib);
    });

    it('exposes the prisma client surface', async () => {
        const prisma = (await import('../../../src/lib/prisma.js')).default;
        // We don't actually call these in this test — we just verify
        // the singleton looks like a PrismaClient, not an empty object.
        expect(typeof prisma.$connect).toBe('function');
        expect(typeof prisma.$disconnect).toBe('function');
        expect(typeof prisma.$queryRaw).toBe('function');
    });
});
