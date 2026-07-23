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
import { tenantScopeExtension } from './tenantScope.js';

const globalForPrisma = globalThis;

// RES-2: bound long-running queries with a Postgres statement_timeout so a
// pathological query can't pin a connection indefinitely. We do this the
// least-invasive way — append an `options=-c statement_timeout=<ms>` startup
// parameter to the connection string ONLY if the operator has not already set
// their own `options` / `statement_timeout` (we never override an explicit
// choice). The RLS extension issues per-transaction `SET LOCAL` for the tenant
// GUC and is unaffected by this server-wide connection default. Conservative 30s.
// Set STATEMENT_TIMEOUT_MS=0 to disable.
const STATEMENT_TIMEOUT_MS = parseInt(process.env.STATEMENT_TIMEOUT_MS || '30000', 10);
function withStatementTimeout(url) {
    if (!url || !Number.isFinite(STATEMENT_TIMEOUT_MS) || STATEMENT_TIMEOUT_MS <= 0) return url;
    // Don't touch a URL that already declares options or a statement_timeout.
    if (/[?&]options=/i.test(url) || /statement_timeout/i.test(url)) return url;
    const sep = url.includes('?') ? '&' : '?';
    // libpq `options` startup param; %20 encodes the space between -c and the setting.
    return `${url}${sep}options=-c%20statement_timeout%3D${STATEMENT_TIMEOUT_MS}`;
}
const DATABASE_URL_WITH_TIMEOUT = withStatementTimeout(process.env.DATABASE_URL);

// HR-01 / HR-10 (T-P4.2): the singleton is wrapped with the C4 encryption
// client extension ($extends). Every src/ module already imports THIS file,
// so encrypt-on-write / decrypt-on-read is transparent — no call site changes.
// $extends returns a NEW client; we cache the extended client so all callers
// (and dev-time reloads) share exactly one encrypted client.
const prisma =
    globalForPrisma.__hrPrisma ??
    new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL_WITH_TIMEOUT }),
        log: process.env.PRISMA_LOG_LEVEL
            ? process.env.PRISMA_LOG_LEVEL.split(',').map((s) => s.trim()).filter(Boolean)
            : ['warn', 'error'],
    }).$extends(c4EncryptionExtension).$extends(rlsTenantExtension).$extends(tenantScopeExtension);

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.__hrPrisma = prisma;
}

export default prisma;
