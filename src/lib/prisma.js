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

const globalForPrisma = globalThis;

const prisma =
    globalForPrisma.__hrPrisma ??
    new PrismaClient({
        log: process.env.PRISMA_LOG_LEVEL
            ? process.env.PRISMA_LOG_LEVEL.split(',').map((s) => s.trim()).filter(Boolean)
            : ['warn', 'error'],
    });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.__hrPrisma = prisma;
}

export default prisma;
