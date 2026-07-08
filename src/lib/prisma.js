// src/lib/prisma.js — single PrismaClient instance for the HR service.
//
// Per ARCH-01 §5.3–5.4 and BE-§7.1, every src/ module must share one
// PrismaClient. The previous shape (new PrismaClient() in each service)
// burned through pooled connections and made test mocking impossible.
//
// We stash the instance on globalThis so that dev-time module reloads
// (nodemon, jest --watch) don't fan out to a new client per reload, but
// production runs see exactly one. `src/config/prisma.js` re-exports
// from this file so legacy `../config/prisma.js` imports keep working.
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { c4EncryptionExtension } from './c4Encryption.js';
import { rlsTenantExtension } from './rlsTenant.js';

const globalForPrisma = globalThis;

// HR-01 / HR-10 (T-P4.2): the singleton is wrapped with the C4 encryption
// client extension ($extends). Every src/ module already imports THIS file,
// so encrypt-on-write / decrypt-on-read is transparent — no call site changes.
// $extends returns a NEW client; we cache the extended client so all callers
// (and dev-time reloads) share exactly one encrypted client.
const prisma =
    globalForPrisma.__hrPrisma ??
    new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
        log: process.env.PRISMA_LOG_LEVEL
            ? process.env.PRISMA_LOG_LEVEL.split(',').map((s) => s.trim()).filter(Boolean)
            : ['warn', 'error'],
    }).$extends(c4EncryptionExtension).$extends(rlsTenantExtension);

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.__hrPrisma = prisma;
}

export default prisma;
