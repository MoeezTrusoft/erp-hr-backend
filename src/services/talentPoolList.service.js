import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { AppError } from "../utils/AppError.js";
import { HR_ERRORS } from "../constants/errorCodes.js";

const invalid = () => {
  throw new AppError("Invalid talent pool filters or pagination", 422, {
    code: HR_ERRORS.VALIDATION.code,
  });
};
const text = (v) => {
  if (v == null) return "";
  if (typeof v !== "string" || v.length > 200) invalid();
  return v.trim();
};
export function normalizePoolQuery(input = {}) {
  const page = Number(input.page ?? 1),
    limit = Number(input.limit ?? 20);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    invalid();
  const sort = input.sort ?? "addedAt",
    order = input.order ?? "desc";
  if (
    !["addedAt", "name", "experienceYears"].includes(sort) ||
    !["asc", "desc"].includes(order)
  )
    invalid();
  return {
    page,
    limit,
    sort,
    order,
    q: text(input.q),
    poolName: text(input.poolName),
    department: text(input.department),
    skill: text(input.skill),
  };
}
// Keep unknown/malformed AI data unknown; zero is a real experience value.
export function poolExperienceYears(parsed) {
  const raw = parsed?.yearsOfExperience ?? parsed?.totalExperience;
  if (
    !["string", "number"].includes(typeof raw) ||
    !/^[0-9]{1,6}(\.[0-9]{1,6})?$/.test(String(raw))
  )
    return null;
  return Number(raw);
}
function poolBase(tenantId, scope) {
  // Match applicationScopeWhere: managers see their latest permitted role.
  const owned =
    scope.level === "ORG"
      ? Prisma.sql`TRUE`
      : Prisma.sql`(j."requestedById"=${scope.employeeId} OR j."approvedById"=${scope.employeeId} OR j."recruiterId"=${scope.employeeId})`;
  return Prisma.sql`WITH base AS (
    SELECT p.id AS "membershipId",p."candidateId",NULLIF(trim(concat_ws(' ',c."firstName",c."lastName")),'') AS name,
      recent.title AS role,recent.department,recent."departmentId",p."poolName",p."addedAt",
      CASE WHEN ${scope.canSeeInternalNotes} THEN p.notes ELSE NULL END AS notes,
      CASE WHEN COALESCE(c."parsedResume"->>'yearsOfExperience',c."parsedResume"->>'totalExperience') ~ '^[0-9]{1,6}([.][0-9]{1,6})?$'
        THEN COALESCE(c."parsedResume"->>'yearsOfExperience',c."parsedResume"->>'totalExperience')::double precision ELSE NULL END AS "experienceYears",
      COALESCE(NULLIF(trim(c.location),''),CASE
        WHEN jsonb_typeof(c."parsedResume"->'location')='string' THEN NULLIF(trim(c."parsedResume"->>'location'),'')
        WHEN jsonb_typeof(c."parsedResume"->'city')='string' THEN NULLIF(trim(c."parsedResume"->>'city'),'')
        WHEN jsonb_typeof(c."parsedResume"->'address')='string' THEN NULLIF(trim(c."parsedResume"->>'address'),'')
        ELSE NULL END) AS location,
      ARRAY(SELECT s.name FROM candidate_skills s WHERE s."tenantId"=${tenantId}::uuid AND s."candidateId"=c.id ORDER BY s.name,s.id) AS skills
    FROM talent_pools p JOIN "Candidate" c ON c.id=p."candidateId" AND c."tenantId"=p."tenantId"
    LEFT JOIN LATERAL (
      SELECT j.title,j."departmentId",b.name AS department FROM "Application" a
      JOIN "JobRequisition" j ON j.id=a."jobRequisitionId" AND j."tenantId"=a."tenantId"
      LEFT JOIN "BusinessUnit" b ON b.id=j."departmentId" AND b."tenantId"=j."tenantId"
      WHERE a."candidateId"=c.id AND a."tenantId"=${tenantId}::uuid AND ${owned}
      ORDER BY a."appliedAt" DESC,a.id DESC LIMIT 1
    ) recent ON TRUE
    WHERE p."tenantId"=${tenantId}::uuid AND c."anonymizedAt" IS NULL AND c.status='active'
      AND (${scope.level === "ORG"} OR recent.title IS NOT NULL)
  )`;
}
export async function listManagedPool(input = {}) {
  const query = normalizePoolQuery(input),
    { tenantId } = input;
  return tenantTransaction(
    prisma,
    async (tx) => {
      const { scope } = await requireRecruitmentActor({ tenantId }, tx);
      const base = poolBase(tenantId, scope),
        clauses = [Prisma.sql`TRUE`];
      if (query.q)
        clauses.push(Prisma.sql`strpos(lower(name),lower(${query.q}))>0`);
      if (query.poolName)
        clauses.push(Prisma.sql`"poolName"=${query.poolName}`);
      if (query.department)
        clauses.push(Prisma.sql`department=${query.department}`);
      if (query.skill) clauses.push(Prisma.sql`${query.skill}=ANY(skills)`);
      const filtered = Prisma.sql`${base}, filtered AS (SELECT * FROM base WHERE ${Prisma.join(clauses, " AND ")})`;
      const order = Prisma.sql`ORDER BY ${Prisma.raw({ addedAt: '"addedAt"', name: "lower(name)", experienceYears: '"experienceYears"' }[query.sort])} ${Prisma.raw(query.order.toUpperCase())} NULLS LAST,"membershipId" ASC`;
      const [{ total }] = await tx.$queryRaw(
        Prisma.sql`${filtered} SELECT count(*)::int total FROM filtered`,
      );
      const items = await tx.$queryRaw(
        Prisma.sql`${filtered} SELECT * FROM filtered ${order} LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`,
      );
      const [facets] = await tx.$queryRaw(Prisma.sql`${base} SELECT
      ARRAY(SELECT DISTINCT "poolName" FROM base ORDER BY "poolName") AS pools,
      ARRAY(SELECT DISTINCT department FROM base WHERE department IS NOT NULL ORDER BY department) AS departments,
      ARRAY(SELECT DISTINCT unnest(skills) AS skill FROM base ORDER BY skill) AS skills`);
      return { items, total, page: query.page, limit: query.limit, facets };
    },
    {
      tenantId,
      txOptions: {
        isolationLevel: "RepeatableRead",
        maxWait: 10000,
        timeout: 30000,
      },
    },
  );
}
