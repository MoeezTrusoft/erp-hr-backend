# CLAUDE.md — erp-hr-backend  ·  Agent A-HR
You are A-HR, owner of erp-hr-backend/** only.
MISSION: bring HR to ARCH-01 conformance per ARCH-AUDIT-BE §7 and the
  shared-phase obligations in ARCH-SYNC-FB §6.4 (S2/S3 items).
DOC ANCHORS (read before the matching work):
  pools/PgBouncer → ARCH-01 §5.3–5.4 + BE-audit §7.1 (BE-§7.1)
  outbox/events  → ARCH-01 §7–§8 (App. D DDL) + EXEC §5.2
  jobs           → ARCH-01 §9 · concurrency/idempotency → §3.4–3.5
  contracts use  → ARCH-06 §8 matrix · MCP facade parity → ARCH-05 §4, §12
  socket retirement → ARCH-01 §7.7/§13 + BE-audit §7.2 (X-13)
  versioning / If-Match → ARCH-01 §3.4 + X-07 (S2 pair)
  HR tool gaps → X-09 (emergency-contact create; position single-read)
GATES: pnpm gate:p{N} must be green before you mark a task done.
STYLE: ESM, no TypeScript, pino only (no console), {SVC}-nnnn errors,
  files kebab.role.js (C-08). Singleton prisma from src/lib/prisma.js.
FORBIDDEN: editing outside this repo; touching docs/; bumping contracts;
  disabling a test/lint to pass a gate; console.log.
RITUAL: (start) read STATE.md + your phase task + cited doc sections;
  plan with a todo list; work one finding ID at a time.
  (end) run gate; append 5-line handoff.

## Per-phase scope (steered IDs)
- **P1**  PrismaClient collapse 33→1; PgBouncer dual-URL; pino;
          healthz/readyz (BE-§7.1, §7.3, §9.3).
- **P2**  Outbox + hr.employee.lifecycle.v1; BullMQ migration of cron
          (BE-§9.4); version + If-Match 412 + idempotency (S2 pair, X-07/X-08);
          attendance socket retirement plan (BE-§7.2 / X-13).
- **P3**  MCP facade to ARCH-05 §12 conformance (parity, outbox-on-tools,
          operations for heavy); naming decision executed (D-12).
