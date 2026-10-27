import { readFile } from "node:fs/promises";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";
import { tenantTransaction } from "../src/lib/rlsTenant.js";
import { allocateEmployeeCode } from "../src/services/employee-code.service.js";
import {
  canonicalEmployeeCode,
  collisionKey,
} from "@trusoft/contracts/employment-rules";
import { EmploymentCategory } from "@trusoft/contracts/employment";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const company = process.argv.includes("--company") ? arg("--company") : null;
const apply = process.argv.includes("--apply");
if (!company)
  throw new Error(
    "Pass --company <verified company UUID>. Default is report only.",
  );
const mapping = process.argv.includes("--category-map")
  ? JSON.parse(await readFile(arg("--category-map"), "utf8"))
  : [];
if (
  !Array.isArray(mapping) ||
  new Set(mapping.map((m) => m.legacyRowId)).size !== mapping.length
)
  throw new Error("Category mappings must have unique legacy row references");
// Technical migration references are used only where a legacy row has no business code.
for (const m of mapping) {
  if (m.companyUuid !== company || !Number.isInteger(m.legacyRowId))
    throw new Error(
      "Every category mapping requires the exact company and legacy row reference",
    );
  EmploymentCategory.parse(m.category);
}
try {
  const report = await mcpCtx.run(
    { system: true },
    async () =>
      await tenantTransaction(
        prisma,
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${company + ":employee-code-backfill"},0))`;
          const rows =
            await tx.$queryRaw`SELECT id,employee_code,"employeeCategory",hire_date,joining_date FROM "Employee" WHERE tenant_id=${company}::uuid ORDER BY hire_date ASC NULLS LAST,joining_date ASC NULLS LAST,id ASC`;
          const issues = [],
            planned = [],
            seen = new Map();
          for (const e of rows) {
            const category =
              e.employeeCategory ||
              mapping.find((m) => m.legacyRowId === e.id)?.category;
            if (!category)
              issues.push({
                legacyRowId: e.id,
                employeeCode: e.employee_code,
                kind: "UNKNOWN_CATEGORY",
              });
            if (!e.employee_code?.trim()) {
              issues.push({
                legacyRowId: e.id,
                kind: "MISSING_CODE",
                canAllocate: !!category,
              });
              if (category) planned.push({ legacyRowId: e.id, category });
              continue;
            }
            try {
              if (canonicalEmployeeCode(e.employee_code) !== e.employee_code)
                throw new Error();
              const key = collisionKey(e.employee_code);
              if (seen.has(key))
                issues.push({
                  legacyRowId: e.id,
                  otherLegacyRowId: seen.get(key),
                  kind: "DUPLICATE_CODE",
                });
              else seen.set(key, e.id);
            } catch {
              issues.push({ legacyRowId: e.id, kind: "NONCANONICAL_CODE" });
            }
          }
          if (apply) {
            if (
              issues.some((i) =>
                ["DUPLICATE_CODE", "NONCANONICAL_CODE"].includes(i.kind),
              )
            )
              throw new Error(
                "Resolve duplicate/noncanonical codes before applying; no coercion is permitted",
              );
            // Reserve existing canonical codes before allocating. History is never recycled.
            for (const e of rows)
              if (
                e.employee_code?.trim() &&
                !(await tx.employeeCodeReservation.findFirst({
                  where: { tenantId: company, employeeCode: e.employee_code },
                }))
              )
                await tx.employeeCodeReservation.create({
                  data: {
                    tenantId: company,
                    employeeCode: e.employee_code,
                    collisionKey: collisionKey(e.employee_code),
                  },
                });
            for (const p of planned) {
              const code = await allocateEmployeeCode(tx, company, p.category);
              await tx.employee.update({
                where: { id: p.legacyRowId },
                select: { id: true },
                data: {
                  employee_code: code,
                  employeeCategory: p.category,
                  version: { increment: 1 },
                },
              });
              p.employeeCode = code;
            }
            for (const e of rows)
              if (e.employee_code && !e.employeeCategory) {
                const m = mapping.find((m) => m.legacyRowId === e.id);
                if (m)
                  await tx.employee.update({
                    where: { id: e.id },
                    select: { id: true },
                    data: {
                      employeeCategory: m.category,
                      version: { increment: 1 },
                    },
                  });
              }
          }
          return { companyUuid: company, applied: apply, issues, planned };
        },
        { system: true, txOptions: { timeout: 120000 } },
      ),
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await prisma.$disconnect();
}
