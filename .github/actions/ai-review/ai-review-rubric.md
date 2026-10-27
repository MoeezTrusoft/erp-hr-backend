# ERP AI-Review Rubric

Review the PR **diff** for the classes of problem that ESLint, unit tests, and a
build **cannot** catch. Be strict, high-confidence, and grounded in the diff.
Report nothing if there is nothing real. Severity guide: **critical** = data
breach / cross-tenant leak / auth bypass / secret exposure; **high** = likely
prod bug or contract break; **medium** = correctness/robustness risk; **low** =
maintainability; **info** = note.

## 1. Multi-tenant isolation (CRITICAL — the #1 ERP risk)
This is a multi-tenant ERP. Tenant identity flows from the verified token
(`tenantId`/`sid`), never a client-supplied header/body.
- Any new DB query, Prisma call, or MCP tool that reads/writes tenant data MUST
  be scoped by `tenantId` (or run under the RLS `app.tenant_id` GUC). Flag a
  query with no tenant predicate.
- Flag RLS-protected models (e.g. Attendance, LeaveRequest, PerformanceReview)
  accessed without the tenant GUC transaction.
- Flag tenant id taken from `req.body`, `req.query`, or a raw header instead of
  the verified token/context.
- Flag any raw SQL that interpolates user input (SQLi) or omits tenant scoping.

## 2. AuthZ / AuthN gaps (CRITICAL/HIGH)
- New route / MCP tool / mutation with no permission check (RBAC `resource:action`)
  or exposed on a public/unauthenticated surface by mistake.
- Weakened checks: `==` instead of constant-time compare for secrets; verify
  disabled; `SERVICE_JWT_*`/`ACCESS_TOKEN_*` acceptance loosened (e.g. HS256
  re-enabled, issuer/audience widened, signature check skipped).
- Missing `x-mcp-internal` / service-JWT gating on internal endpoints.

## 3. Cross-service contract drift (HIGH)
Services talk over MCP tools + events; the gateway federates them.
- A changed MCP tool name / input schema / output shape that a consumer relies on.
- An event payload (e.g. `iam.permissions.updated.v1`, `comms.message.created`)
  whose shape changed without a version bump — breaks subscribers.
- Renamed/removed export consumed elsewhere; a gateway `SERVICE_MAP` / `*_URL`
  route that no longer matches the target.

## 4. Secret / PII handling (CRITICAL)
- Logging tokens, passwords, cookies, service-JWTs, or PII. Verify pino `redact`
  paths still cover new sensitive fields; flag `console.log` of request objects.
- Secrets hard-coded or added to committed files / env defaults.
- Refresh/access token TTL or cookie attributes (`HttpOnly`/`Secure`/`SameSite`)
  weakened.

## 5. Architecture-rule violations (HIGH/MEDIUM)
- **Frontend:** zero cross-domain imports (`src/domains/x` must not import from
  `src/domains/y`); access token stays **in-memory only** (never localStorage);
  all API access via the one MCP client (no stray axios/fetch); tokens via
  `@trusoft/tokens` (no raw hex / Tailwind arbitrary values).
- **Backend:** a service must not reach into another service's DB; ESM only; pino
  only (no `console.log`); errors as `{CODE}-nnnn`.
- Domain/service boundary crossings; a repo editing outside its ownership.

## 6. Correctness & data safety (HIGH/MEDIUM)
- N+1 queries; unbounded/unpaginated list reads; missing `LIMIT`.
- Event/outbox handlers without idempotency or that can double-process on retry;
  race conditions; unhandled promise rejections; missing `await`.
- Migrations that are destructive, non-reversible, lock large tables, or drop
  columns still read by running code (backward-incompat deploy).
- Money/quantity math with floats where precision matters; timezone/`Date` bugs.

## 7. Incomplete refactors & dead code (MEDIUM — this class recently broke prod)
- A refactor that leaves orphaned code (e.g. a `return` with no enclosing
  function, references to deleted symbols/props), a half-renamed component, or an
  import of something never defined/exported.
- Case-sensitive path/import mismatches (works on macOS, fails on Linux CI).
- New component/util referenced app-wide but not actually implemented/exported.

## 8. Tests & observability (MEDIUM/LOW)
- Behavior changed with no added/updated test; a test weakened or skipped to pass.
- New failure path with no structured log / metric / trace; error swallowed
  silently (`catch {}`) on a critical path.

For each real issue give: file, line (if determinable), severity, category (one
of the section names), a one-line title, a concrete detail tied to the diff, and
a specific fix suggestion.
