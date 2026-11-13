-- A.4 — HR transactional outbox (ARCH-01 §7–§8).
--
-- Adds the `outbox_events` table: HR's first outbox. A domain event row is
-- inserted INSIDE the same transaction as the source Employee aggregate write
-- (create/update/terminate), so the event and the business change commit or
-- roll back together. A claim/lease dispatcher drains unpublished rows and
-- XADDs the persisted EventEnvelope to a Redis stream.
--
-- tenantId is the RBAC Company.uuid (UUID), matching REQ-007 tenancy in this
-- service. Mirrors erp-communication-backend's CommunicationOutbox shape.

CREATE TABLE "outbox_events" (
    "id"             TEXT NOT NULL,
    "tenantId"       UUID NOT NULL,
    "eventName"      TEXT NOT NULL,
    "aggregateType"  TEXT NOT NULL,
    "aggregateId"    TEXT NOT NULL,
    "payload"        JSONB NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt"    TIMESTAMP(3),
    "attempts"       INTEGER NOT NULL DEFAULT 0,
    "lastError"      TEXT,
    "claimedAt"      TIMESTAMP(3),
    "claimedBy"      TEXT,
    "claimExpiresAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- Tenant-scoped backlog lookups.
CREATE INDEX "outbox_events_tenantId_publishedAt_idx"
    ON "outbox_events" ("tenantId", "publishedAt");

-- Ordered drain of unpublished rows.
CREATE INDEX "outbox_events_publishedAt_createdAt_idx"
    ON "outbox_events" ("publishedAt", "createdAt");

-- Dispatcher candidate scan: free or expired claim, oldest first.
CREATE INDEX "outbox_events_publishedAt_claimExpiresAt_createdAt_idx"
    ON "outbox_events" ("publishedAt", "claimExpiresAt", "createdAt");
