# Migration Rules for erp-hr-backend (REQ-HR-DEPLOY-HARDENING-2026-09-02 §1c)

## The rule

**A release may ADD a column or a table. A release may NOT drop or rename one
that the previous image still reads.**

Drops and renames go in the release *after* the one that stopped reading the
thing being dropped. Two releases, always, for anything destructive.

## Why

`kubectl -n erp-svc rollout undo deploy/erp-hr-backend` is the only rollback
this service has. It puts the previous image back. It does not put the previous
schema back — nothing does, and nothing should.

So if release N drops a column that image N-1 still selects, then the moment you
roll back, image N-1 returns to a database it cannot parse. Every query touching
that table fails. Your rollback made the outage worse than the bug you were
rolling back from, and now the only way forward is forward, at 3am, writing a
migration under pressure.

Expand/contract makes rollback real. Additive migrations are compatible with
both images, so the old one keeps working the entire time.

## Two replicas make this stricter

`erp-hr-backend` runs 2 replicas with a PodDisruptionBudget of `minAvailable: 1`.

That is not a detail; it is the core of the rule. During a rolling update, one
pod is on the old image and one is on the new image, and **both are serving
traffic at the same time, against the same database**. There is no instant where
only one version is live.

So the compatibility window is not "until the rollout finishes" — the two
versions genuinely overlap. The schema has to satisfy the old code and the new
code simultaneously, for the whole rollout, every rollout. A destructive
migration does not just break rollback; it breaks the old replica while the
rollout is still in progress, before you have any signal that something is
wrong.

This is also why `scripts/DEPLOY.runbook.md` applies migrations *before* rolling
the image. An additive migration is safe against the still-running old image by
construction — the old code simply never mentions the new column.

## Right and wrong, concretely

### Removing a column

**Wrong — one release:**

```
-- release N
ALTER TABLE "Attendance" DROP COLUMN "legacy_shift_code";
```
…shipped alongside the code change that stopped reading `legacy_shift_code`.

This looks clean and is a trap. During the rolling update the old replica is
still selecting `legacy_shift_code` and now errors on every read. And if you
roll back, you roll back into the same failure permanently.

**Right — two releases:**

```
-- release N: no migration at all.
-- Code change only: stop reading and stop writing legacy_shift_code.
-- The column stays in the database, unused, ignored by both replicas.
```

```
-- release N+1: now nothing reads it, so it can go.
ALTER TABLE "Attendance" DROP COLUMN "legacy_shift_code";
```

Release N is fully rollback-safe: the column is still there for image N-1.
Release N+1 is rollback-safe too, because image N — the one `rollout undo`
restores — already stopped reading the column.

### Renaming a column

A rename is a drop and an add in one statement, so it is the same trap wearing a
different hat.

**Wrong — one release:**

```
ALTER TABLE "leave_requests" RENAME COLUMN "start_date" TO "startDate";
```

The old replica's `SELECT "start_date"` breaks the instant that runs.

**Right — three releases, or two if you can tolerate a dual-write window:**

```
-- release N: add the new column, backfill, dual-write.
ALTER TABLE "leave_requests" ADD COLUMN "startDate" TIMESTAMP(3);
UPDATE "leave_requests" SET "startDate" = "start_date" WHERE "startDate" IS NULL;
-- code writes both columns, reads the old one.
```

```
-- release N+1: no migration. Code reads the new column, still writes both.
```

```
-- release N+2: nothing reads or writes the old column.
ALTER TABLE "leave_requests" DROP COLUMN "start_date";
```

Note the new column is added **nullable**. A `NOT NULL` column with no default
is itself a breaking change: the old image's INSERTs do not supply it and start
failing. Add nullable, backfill, and only add the constraint once every writer
populates it.

### What is always safe in a single release

- `ADD COLUMN` — nullable, or with a default.
- `CREATE TABLE`.
- `CREATE INDEX` (see the note on `CONCURRENTLY` below).

The old image does not know these exist, so it cannot be broken by them.

### What is never safe in a single release

- `DROP COLUMN`, `DROP TABLE`.
- `RENAME COLUMN`, `RENAME TABLE`.
- `ADD COLUMN ... NOT NULL` without a default.
- Narrowing a type or tightening a constraint that existing writers can violate.
- Changing an enum value the old image still emits.

---

## Expected drift — do not "fix" this

`prisma migrate diff` against the `erp-hr` database **will never come back
empty**. This is known, it is intentional, and every attempt to make it clean
makes production worse. Three separate causes:

### (a) The concurrent partial indexes are outside the Prisma chain

`scripts/sql/F-DB-06-08-14.hr-indexes.sql` contains 29 `CREATE INDEX
CONCURRENTLY` statements, several of them partial (`WHERE "publishedAt" IS NULL
AND "claimedAt" IS NULL`, and so on). `ARCH-01 §5.5` requires production indexes
to be built concurrently, after the transactional migration phase, because
`CONCURRENTLY` cannot run inside a transaction and a plain `CREATE INDEX` takes
a lock that a busy attendance or payroll table cannot afford.

Prisma's datamodel cannot express a partial index, so `schema.prisma` cannot
declare these, so `migrate diff` reports them as extra indexes in the database
forever. They are supposed to be there. Deploy them with `npm run
db:indexes:deploy`; the procedure is in
`scripts/F-DB-06-08-14.hr-indexes.runbook.md`.

Do not let Prisma generate non-concurrent equivalents to close the gap. That
swaps a documented diff for a table lock during payroll.

### (b) `updatedAt` and `tenantId` have database defaults the datamodel does not

Several tables carry DB-level defaults where the Prisma datamodel declares none.
`migrate diff` flags each one.

Production is the *safer* side of this diff. `tenantId` defaults to
`hr_current_tenant()` rather than `NULL` — meaning a row inserted by any path
that bypasses the application's tenant stamping still lands correctly scoped
instead of landing tenant-less and invisible to RLS. Removing those defaults to
match the datamodel would trade a cosmetic diff for silent cross-tenant data
loss.

Leave them. If anything, the datamodel is the thing that is behind.

### (c) Six foreign keys are `ON UPDATE NO ACTION` where the datamodel says `CASCADE`

Six FK constraints in `erp-hr` sit at `ON UPDATE NO ACTION`; `schema.prisma`
declares `ON UPDATE CASCADE`. `migrate diff` reports all six.

This difference is inert. Every parent key involved is an autoincrement integer
primary key. Nothing ever updates one — there is no code path that changes a
row's own `id`, and there is no business reason to. `ON UPDATE` therefore never
fires, and the two settings are behaviourally identical in this database.

Rewriting six FK constraints in production to silence a diff that describes a
branch that cannot execute is pure downside: each `ALTER TABLE ... DROP
CONSTRAINT / ADD CONSTRAINT` takes an ACCESS EXCLUSIVE lock and re-validates the
whole table.

---

## Before you write a migration, ask

1. Does it drop or rename anything the currently-deployed image reads? If yes,
   split it into two releases. Ship the code change first.
2. Is any new column `NOT NULL` without a default? If yes, make it nullable now
   and tighten it in a later release.
3. Would the old image keep working against this schema for the entire duration
   of a rolling update with both replicas live? If you cannot answer yes, it is
   not additive.
4. Does the diff you are looking at belong to one of the three classes above? If
   yes, leave it alone.
