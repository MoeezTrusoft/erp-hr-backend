import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
const fail = (message, status = 422) => {
  throw Object.assign(new Error(message), {
    status,
    code: status === 403 ? "HR-5304" : status === 412 ? "HR-4120" : "HR-5301",
  });
};
const tx = (tenantId, fn, options = {}) =>
  tenantTransaction(prisma, fn, {
    tenantId,
    txOptions: { maxWait: 10000, timeout: 30000, ...options },
  });
const active = (tenantId) => Prisma.sql`WITH active AS NOT MATERIALIZED (
 SELECT id,version,"firstName","lastName",email,public.hr_candidate_duplicate_keys(email,phone,"parsedResume") AS keys
 FROM "Candidate" WHERE "tenantId"=${tenantId}::uuid AND status='active' AND "anonymizedAt" IS NULL
), pairs AS (
 SELECT l.id AS "leftId",r.id AS "rightId",encode(sha256(convert_to(array_to_string(l.keys,'|')||':'||array_to_string(r.keys,'|'),'UTF8')),'hex') AS "evidenceHash",
 ARRAY(SELECT DISTINCT split_part(k,':',1) FROM unnest(l.keys) k WHERE k=ANY(r.keys) ORDER BY 1) AS reasons
 FROM active l JOIN active r ON r.id>l.id AND l.keys && r.keys
)`;
const human = async (tenantId, db, permission = "hr.recruitment.update") => {
  const result = await requireRecruitmentActor(
    { tenantId, permission, allowedScopes: ["ORG"] },
    db,
  );
  const user = currentRequestContext()?.user;
  if (user?.isAutomation || user?.tokenClaims?.act?.type === "automation")
    fail("An employee must review duplicate suggestions", 403);
  return result;
};
async function scanTenant(tenantId, now) {
  return tx(tenantId, async (db) => {
    const [{ locked }] =
      await db.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${"duplicate:" + tenantId},0)) locked`;
    if (!locked)
      return { created: 0, refreshed: 0, resolved: 0, more: false, busy: true };
    const pending =
      await db.$queryRaw(Prisma.sql`${active(tenantId)} SELECT p.* FROM pairs p LEFT JOIN "CandidateDuplicateSuggestion" s
    ON s."tenantId"=${tenantId}::uuid AND s."leftId"=p."leftId" AND s."rightId"=p."rightId"
    WHERE s.id IS NULL OR s."evidenceHash"<>p."evidenceHash" OR s.state='RESOLVED'
    ORDER BY p."leftId",p."rightId" LIMIT 201`);
    const batch = pending.slice(0, 200),
      ids = [
        ...new Set(batch.flatMap((row) => [row.leftId, row.rightId])),
      ].sort((a, b) => a - b);
    if (ids.length)
      await db.$queryRaw`SELECT id FROM "Candidate" WHERE "tenantId"=${tenantId}::uuid AND id=ANY(${ids}::int[]) ORDER BY id FOR SHARE`;
    // Re-evaluate the whole bounded batch under candidate locks and write it
    // in one statement; per-pair round trips exceeded the transaction budget.
    let created = 0,
      refreshed = 0;
    if (batch.length) {
      const selected = Prisma.join(
        batch.map(
          (row) => Prisma.sql`(${row.leftId}::int,${row.rightId}::int)`,
        ),
      );
      const changed =
        await db.$queryRaw(Prisma.sql`${active(tenantId)}, selected("leftId","rightId") AS (VALUES ${selected})
        INSERT INTO "CandidateDuplicateSuggestion"(id,"tenantId","leftId","rightId","evidenceHash",reasons,"createdAt","updatedAt")
        SELECT gen_random_uuid(),${tenantId}::uuid,p."leftId",p."rightId",p."evidenceHash",p.reasons,${now},${now}
        FROM pairs p JOIN selected k ON k."leftId"=p."leftId" AND k."rightId"=p."rightId" ORDER BY p."leftId",p."rightId"
        ON CONFLICT("tenantId","leftId","rightId") DO UPDATE SET "evidenceHash"=EXCLUDED."evidenceHash",reasons=EXCLUDED.reasons,state='OPEN',version="CandidateDuplicateSuggestion".version+1,"reviewedById"=NULL,"reviewedAt"=NULL,"reviewReason"=NULL,"updatedAt"=EXCLUDED."updatedAt"
        RETURNING (xmax=0) AS created`);
      created = changed.filter((row) => row.created).length;
      refreshed = changed.length - created;
    }
    const resolved =
      await db.$executeRaw(Prisma.sql`${active(tenantId)} UPDATE "CandidateDuplicateSuggestion" s SET state='RESOLVED',version=version+1,"updatedAt"=${now}
    WHERE s."tenantId"=${tenantId}::uuid AND s.state<>'RESOLVED' AND NOT EXISTS(SELECT 1 FROM pairs p WHERE p."leftId"=s."leftId" AND p."rightId"=s."rightId")`);
    if (created || refreshed || resolved) {
      const event = await enqueueHrDomainEvent(db, {
        tenantId,
        eventName: "hr.recruitment.duplicate_suggestions_updated.v1",
        aggregateType: "CandidateDuplicateQueue",
        aggregateId: tenantId,
        payload: { created, refreshed, resolved },
      });
      if (!event) fail("Duplicate queue audit could not be saved", 503);
    }
    return {
      created,
      refreshed,
      resolved,
      more: pending.length > 200,
      busy: false,
    };
  });
}
export async function refreshCandidateDuplicates({ tenantId }) {
  await tx(tenantId, (db) => human(tenantId, db));
  return scanTenant(tenantId, new Date());
}
export async function runCandidateDuplicateDetection({
  now = new Date(),
} = {}) {
  if (!currentRequestContext()?.system)
    fail("Scheduler identity required", 403);
  const tenants = await prisma.candidate.findMany({
    where: { tenantId: { not: null }, status: "active", anonymizedAt: null },
    distinct: ["tenantId"],
    select: { tenantId: true },
  });
  const results = [];
  for (const { tenantId } of tenants)
    await runWithRequestContext(
      { system: false, user: { tenantId } },
      async () =>
        results.push({ tenantId, ...(await scanTenant(tenantId, now)) }),
    );
  return { results };
}
export async function listCandidateDuplicates({
  tenantId,
  page = 1,
  pageSize = 20,
  state = "OPEN",
} = {}) {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !["OPEN", "DISMISSED"].includes(state)
  )
    fail("Invalid duplicate queue filters");
  return tx(
    tenantId,
    async (db) => {
      await human(tenantId, db, "hr.recruitment.read");
      const filtered = Prisma.sql`${active(tenantId)}, queue AS (SELECT s.* FROM "CandidateDuplicateSuggestion" s JOIN pairs p ON p."leftId"=s."leftId" AND p."rightId"=s."rightId" AND p."evidenceHash"=s."evidenceHash" WHERE s."tenantId"=${tenantId}::uuid AND s.state=${state})`;
      const [{ total }] = await db.$queryRaw(
        Prisma.sql`${filtered} SELECT count(*)::int total FROM queue`,
      );
      const items =
        await db.$queryRaw(Prisma.sql`${filtered} SELECT s.id,s.version,s.state,s.reasons,s."reviewReason",s."reviewedAt",s."updatedAt",
    jsonb_build_object('id',l.id,'name',trim(concat_ws(' ',l."firstName",l."lastName")),'email',l.email) AS left,
    jsonb_build_object('id',r.id,'name',trim(concat_ws(' ',r."firstName",r."lastName")),'email',r.email) AS right
    FROM queue s JOIN active l ON l.id=s."leftId" JOIN active r ON r.id=s."rightId" ORDER BY s."updatedAt" DESC,s.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
      return { items, total, page, pageSize };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
export async function dismissCandidateDuplicate({
  tenantId,
  id,
  expectedVersion,
  reason,
}) {
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      id,
    ) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    typeof reason !== "string" ||
    reason.trim().length < 10 ||
    reason.trim().length > 1000
  )
    fail(
      "Choose a current suggestion and provide a review rationale (10–1000 characters)",
    );
  return tx(tenantId, async (db) => {
    const { who } = await human(tenantId, db);
    const [original] =
      await db.$queryRaw`SELECT "leftId","rightId" FROM "CandidateDuplicateSuggestion" WHERE "tenantId"=${tenantId}::uuid AND id=${id}::uuid`;
    if (!original) fail("Duplicate suggestion not found", 404);
    await db.$queryRaw`SELECT id FROM "Candidate" WHERE "tenantId"=${tenantId}::uuid AND id=ANY(${[original.leftId, original.rightId]}::int[]) ORDER BY id FOR SHARE`;
    const [row] = await db.$queryRaw(
      Prisma.sql`${active(tenantId)} SELECT s.* FROM "CandidateDuplicateSuggestion" s JOIN pairs p ON p."leftId"=s."leftId" AND p."rightId"=s."rightId" AND p."evidenceHash"=s."evidenceHash" WHERE s."tenantId"=${tenantId}::uuid AND s.id=${id}::uuid FOR UPDATE OF s`,
    );
    if (!row || row.version !== expectedVersion || row.state !== "OPEN")
      fail("Suggestion changed; refresh before reviewing", 412);
    const [result] =
      await db.$queryRaw`UPDATE "CandidateDuplicateSuggestion" SET state='DISMISSED',version=version+1,"reviewedById"=${who.id},"reviewedAt"=CURRENT_TIMESTAMP,"reviewReason"=${reason.trim()},"updatedAt"=CURRENT_TIMESTAMP WHERE id=${id}::uuid AND "tenantId"=${tenantId}::uuid RETURNING id,version,state`;
    await db.log.create({
      data: {
        tenantId,
        module: "Candidate Duplicate",
        action_type: "DUPLICATE_DISMISSED",
        employeeId: who.id,
        actionById: who.id,
        type: "Update",
        ip: "unknown",
        os: "server",
        result: "SUCCESS",
        notes: `Suggestion ${id} dismissed after identity review.`,
      },
    });
    const event = await enqueueHrDomainEvent(db, {
      tenantId,
      actorId: who.id,
      actorType: "user",
      eventName: "hr.recruitment.duplicate_suggestions_updated.v1",
      aggregateType: "CandidateDuplicateQueue",
      aggregateId: tenantId,
      payload: { created: 0, refreshed: 0, resolved: 1 },
    });
    if (!event) fail("Duplicate review audit could not be saved", 503);
    return result;
  });
}
