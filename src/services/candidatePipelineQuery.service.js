// Read-only application projection. Workflow writes remain in applicationService.
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { requireRecruitmentActor } from "./recruitmentActor.service.js";
import { listDepartments } from "./rbac.client.js";
import { AppError } from "../utils/AppError.js";
import { HR_ERRORS } from "../constants/errorCodes.js";

export const PIPELINE_STAGES = [
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
  "on_hold",
  "withdrawn",
];
const invalid = () => {
  throw new AppError("Invalid pipeline filters or pagination", 422, {
    code: HR_ERRORS.VALIDATION.code,
  });
};
const text = (v) => {
  if (v == null) return "";
  if (typeof v !== "string" || v.length > 200) invalid();
  return v.trim();
};
const integer = (v, fallback, max) => {
  if (v == null) return fallback;
  if (
    !["string", "number"].includes(typeof v) ||
    !Number.isSafeInteger(Number(v)) ||
    Number(v) < 1 ||
    Number(v) > max
  )
    invalid();
  return Number(v);
};
export function normalizePipelineQuery(input = {}) {
  const sort = input.sort ?? "desc",
    stage = input.stage ?? "";
  if (
    !["asc", "desc", "name_asc", "experience_asc", "experience_desc"].includes(
      sort,
    ) ||
    (stage && !PIPELINE_STAGES.includes(stage))
  )
    invalid();
  return {
    sort,
    stage,
    q: text(input.q),
    source: text(input.source),
    departmentId: integer(input.departmentId, null, 2147483647),
    requisitionId: integer(input.requisitionId, null, 2147483647),
    page: integer(input.page, 1, 100000),
    pageSize: integer(input.pageSize, 20, 100),
  };
}
function baseQuery(tenantId, scope) {
  const owned =
    scope.level === "ORG"
      ? Prisma.sql`TRUE`
      : scope.level === "MANAGED"
        ? Prisma.sql`(j."requestedById"=${scope.employeeId} OR j."approvedById"=${scope.employeeId} OR j."recruiterId"=${scope.employeeId})`
        : Prisma.sql`EXISTS (SELECT 1 FROM interviews i JOIN interview_interviewers p ON p."interviewId"=i.id AND p."tenantId"=i."tenantId"
        WHERE i."tenantId"=${tenantId}::uuid AND i."applicationId"=a.id AND p."employeeId"=${scope.employeeId})`;
  return Prisma.sql`WITH base AS (
    SELECT a.id AS "applicationId",a."candidateId",a."jobRequisitionId",a.version,a."talentPoolInvitationId",a.status,a.stage,a."appliedAt" AS "appliedDate",
      trim(concat_ws(' ',c."firstName",c."lastName")) AS name,c.email,COALESCE(NULLIF(a.source,''),c.source) AS source,c."parseStatus",c."resumeMediaId",
      j.title AS position,j."departmentId",
      CASE WHEN COALESCE(c."parsedResume"->>'yearsOfExperience',c."parsedResume"->>'totalExperience',c."parsedResume"->>'experienceYears') ~ '^[0-9]{1,6}([.][0-9]{1,6})?$'
        THEN COALESCE(c."parsedResume"->>'yearsOfExperience',c."parsedResume"->>'totalExperience',c."parsedResume"->>'experienceYears')::double precision ELSE NULL END AS "yearsExperience"
    FROM "Application" a JOIN "Candidate" c ON c.id=a."candidateId" AND c."tenantId"=a."tenantId"
      JOIN "JobRequisition" j ON j.id=a."jobRequisitionId" AND j."tenantId"=a."tenantId"
    WHERE a."tenantId"=${tenantId}::uuid AND c."anonymizedAt" IS NULL AND ${owned}
  )`;
}
async function queryPipeline(input, all = false) {
  const query = normalizePipelineQuery(input),
    { tenantId } = input;
  const data = await tenantTransaction(
    prisma,
    async (tx) => {
      const { scope } = await requireRecruitmentActor(
        { tenantId, allowedScopes: ["ORG", "MANAGED", "ASSIGNED"] },
        tx,
      );
      const base = baseQuery(tenantId, scope),
        clauses = [Prisma.sql`TRUE`];
      if (query.q)
        clauses.push(
          Prisma.sql`(strpos(lower(name),lower(${query.q}))>0 OR strpos(lower(email),lower(${query.q}))>0 OR strpos(lower(position),lower(${query.q}))>0)`,
        );
      if (query.source) clauses.push(Prisma.sql`source=${query.source}`);
      if (query.stage) clauses.push(Prisma.sql`stage=${query.stage}`);
      if (query.departmentId)
        clauses.push(Prisma.sql`"departmentId"=${query.departmentId}`);
      if (query.requisitionId)
        clauses.push(Prisma.sql`"jobRequisitionId"=${query.requisitionId}`);
      const filtered = Prisma.sql`${base}, filtered AS (SELECT * FROM base WHERE ${Prisma.join(clauses, " AND ")})`;
      const order = Prisma.raw(
        {
          asc: '"appliedDate" ASC',
          desc: '"appliedDate" DESC',
          name_asc: "lower(name) ASC",
          experience_asc: '"yearsExperience" ASC NULLS LAST',
          experience_desc: '"yearsExperience" DESC NULLS LAST',
        }[query.sort],
      );
      const [{ total }] = await tx.$queryRaw(
        Prisma.sql`${filtered} SELECT count(*)::int total FROM filtered`,
      );
      const items = await tx.$queryRaw(
        Prisma.sql`${filtered} SELECT * FROM filtered ORDER BY ${order},"applicationId" ASC ${all ? Prisma.empty : Prisma.sql`LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`}`,
      );
      const counts = await tx.$queryRaw(
        Prisma.sql`${filtered} SELECT stage,count(*)::int count FROM filtered GROUP BY stage`,
      );
      const [facets] = await tx.$queryRaw(Prisma.sql`${base} SELECT
      ARRAY(SELECT DISTINCT "departmentId" FROM base WHERE "departmentId" IS NOT NULL ORDER BY "departmentId") AS departments,
      ARRAY(SELECT DISTINCT source FROM base WHERE source IS NOT NULL AND trim(source)<>'' ORDER BY source) AS sources`);
      return {
        items,
        total,
        facets,
        stageCounts: Object.fromEntries(
          PIPELINE_STAGES.map((stage) => [
            stage,
            counts.find((row) => row.stage === stage)?.count ?? 0,
          ]),
        ),
      };
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
  // RBAC owns department names; facets contain only departments in permitted rows.
  const departments = new Map(
    (await listDepartments()).map((d) => [Number(d.id), d.name]),
  );
  const department = (id) =>
    id == null
      ? null
      : { id, name: departments.get(id) || `Department #${id}` };
  return {
    ...data,
    page: query.page,
    pageSize: query.pageSize,
    facets: {
      ...data.facets,
      departments: data.facets.departments.map(department),
    },
    items: data.items.map((item) => {
      const row = { ...item };
      delete row.email;
      delete row.resumeMediaId;
      return {
        ...row,
        department: department(row.departmentId),
        documents: item.resumeMediaId
          ? [{ type: "resume", mediaId: item.resumeMediaId }]
          : [],
      };
    }),
  };
}
export const listPipelineCards = (input = {}) => queryPipeline(input);
export async function getPipelineBoard(input = {}) {
  const data = await queryPipeline(input, true);
  return {
    columns: PIPELINE_STAGES.map((stage) => ({
      stage,
      count: data.stageCounts[stage],
      cards: data.items.filter((row) => row.stage === stage),
    })),
    total: data.total,
    facets: data.facets,
  };
}
