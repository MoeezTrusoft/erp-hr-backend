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
// Load .env BEFORE the PrismaClient below is constructed. ESM hoists
// `import { prisma }` (via app.js) above `dotenv.config()` in the service
// entrypoint, so the client would otherwise be built with
// process.env.DATABASE_URL === undefined and every DB-backed tool fails to
// connect. Loading dotenv here guarantees the URL is present at construction
// regardless of caller import order. Re-running config() is idempotent.
import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { auditActorExtension } from './auditActor.js';
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
//
// The same startup parameter pins the SESSION TIMEZONE to UTC. Prisma's pg
// driver adapter decodes timestamptz assuming a UTC session: against a server
// whose default is Asia/Karachi it read `2026-11-04 19:12:56+05` as
// `2026-11-04T19:12:56Z`, so every timestamp the app loaded was 5 hours in the
// future. That is what made a stale PROCESSING payroll run look fresh (the
// recalculation check compares `updated_at` with the app clock). Production
// already runs Etc/UTC; pinning it makes every environment match instead of
// inheriting whatever the server defaults to. No code in src/ formats
// timestamps with the session timezone (no current_date / to_char(now())).
const STATEMENT_TIMEOUT_MS = parseInt(process.env.STATEMENT_TIMEOUT_MS || '30000', 10);
const SESSION_TIMEZONE = 'UTC';
function withSessionDefaults(url) {
    if (!url) return url;
    // Don't touch a URL that already declares options or a statement_timeout
    // (the operator's explicit choice wins, timezone included).
    if (/[?&]options=/i.test(url) || /statement_timeout/i.test(url)) return url;
    const sep = url.includes('?') ? '&' : '?';
    const settings = [];
    if (Number.isFinite(STATEMENT_TIMEOUT_MS) && STATEMENT_TIMEOUT_MS > 0) {
        settings.push(`-c statement_timeout=${STATEMENT_TIMEOUT_MS}`);
    }
    settings.push(`-c timezone=${SESSION_TIMEZONE}`);
    // libpq `options` startup param; encodeURIComponent turns the spaces into %20.
    return `${url}${sep}options=${encodeURIComponent(settings.join(' '))}`;
}
const DATABASE_URL_WITH_TIMEOUT = withSessionDefaults(process.env.DATABASE_URL);

// HR-01 / HR-10 (T-P4.2): the singleton is wrapped with the C4 encryption
// client extension ($extends). Every src/ module already imports THIS file,
// so encrypt-on-write / decrypt-on-read is transparent — no call site changes.
// $extends returns a NEW client; we cache the extended client so all callers
// (and dev-time reloads) share exactly one encrypted client.
const prisma =
    globalForPrisma.__hrPrisma ??
    new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL_WITH_TIMEOUT, pool: { max: parseInt(process.env.DB_POOL_MAX, 10) || 5 } }),
        log: process.env.PRISMA_LOG_LEVEL
            ? process.env.PRISMA_LOG_LEVEL.split(',').map((s) => s.trim()).filter(Boolean)
            : ['warn', 'error'],
    }).$extends(c4EncryptionExtension).$extends(rlsTenantExtension).$extends(tenantScopeExtension).$extends(auditActorExtension);

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.__hrPrisma = prisma;
}

export default prisma;
