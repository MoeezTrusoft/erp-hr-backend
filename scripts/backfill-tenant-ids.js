#!/usr/bin/env node
// F-DB-05: explicit, deterministic tenant backfill for rows that have no
// authoritative local parent. No tenant is inferred from a default.
//
// Report only:
//   node scripts/backfill-tenant-ids.js --report
// Apply reviewed mappings, then print the remaining report:
//   node scripts/backfill-tenant-ids.js --mapping ./tenant-mapping.json --report
//
// Mapping format:
// [
//   { "model": "Candidate", "where": { "id": 42 },
//     "tenantId": "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007" }
// ]
import { readFile } from "node:fs/promises";
import process from "node:process";
import "dotenv/config";
import { Client } from "pg";

const args = process.argv.slice(2);
const mappingFlag = args.indexOf("--mapping");
const mappingPath = mappingFlag >= 0 ? args[mappingFlag + 1] : null;
const reportOnly = args.includes("--report") && !mappingPath;

function fail(message) {
  process.stderr.write(`F-DB-05 tenant backfill: ${message}\n`);
  process.exitCode = 1;
}

if (mappingFlag >= 0 && !mappingPath) {
  fail("--mapping requires a JSON file path");
} else if (!mappingPath && !args.includes("--report")) {
  fail("choose --report or --mapping <reviewed-json> [--report]");
}

const databaseUrl = process.env.DATABASE_URL;
if (!process.exitCode && !databaseUrl) fail("DATABASE_URL is required");

function quote(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function parseModels(schema) {
  const models = new Map();
  for (const match of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = match;
    const mapMatch = body.match(/@@map\("([^"]+)"\)/);
    const tenantMatch = body.match(/^\s*(tenantId|tenant_id)\s+String\?/m);
    if (!tenantMatch) continue;

    const scalarFields = new Set(
      [...body.matchAll(/^\s*(\w+)\s+(?:String|Int|BigInt|Boolean|DateTime|Float|Decimal|Json)(?:\?|\[\])?/gm)]
        .map((field) => field[1]),
    );
    const idFields = [...body.matchAll(/^\s*(\w+)\s+[^\n]*@id\b/gm)].map((field) => field[1]);
    const compoundId = body.match(/@@id\(\[([^\]]+)\]\)/);
    if (compoundId) {
      idFields.push(...compoundId[1].split(",").map((field) => field.trim()));
    }
    models.set(name, {
      table: mapMatch?.[1] ?? name,
      tenantColumn: tenantMatch[1],
      scalarFields,
      idFields: [...new Set(idFields)],
    });
  }
  return models;
}

function assertUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

async function printReport(client) {
  const result = await client.query(
    "SELECT table_name, tenant_column, unresolved_rows FROM public.hr_tenant_backfill_report() WHERE unresolved_rows > 0 ORDER BY table_name",
  );
  process.stdout.write(`${JSON.stringify({ finding: "F-DB-05", unresolved: result.rows }, null, 2)}\n`);
  return result.rows;
}

async function main() {
  if (process.exitCode) return;
  const schema = await readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const models = parseModels(schema);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    if (reportOnly) {
      await printReport(client);
      return;
    }

    const mappings = JSON.parse(await readFile(mappingPath, "utf8"));
    if (!Array.isArray(mappings) || mappings.length === 0) {
      throw new Error("mapping file must contain a non-empty JSON array");
    }

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_bypass', 'on', true)");
    for (const [index, entry] of mappings.entries()) {
      const spec = models.get(entry?.model);
      if (!spec) throw new Error(`mapping[${index}].model is not a nullable tenant model`);
      assertUuid(entry.tenantId, `mapping[${index}].tenantId`);
      if (!entry.where || typeof entry.where !== "object" || Array.isArray(entry.where)) {
        throw new Error(`mapping[${index}].where must identify one row by its primary key`);
      }
      const whereFields = Object.keys(entry.where).sort();
      const idFields = [...spec.idFields].sort();
      if (whereFields.length !== idFields.length || whereFields.some((field, i) => field !== idFields[i])) {
        throw new Error(`mapping[${index}].where must contain exactly the primary key: ${idFields.join(", ")}`);
      }
      if (whereFields.some((field) => !spec.scalarFields.has(field))) {
        throw new Error(`mapping[${index}].where contains an unknown field`);
      }

      const predicates = whereFields.map((field, i) => `${quote(field)} = $${i + 2}`).join(" AND ");
      const values = [entry.tenantId, ...whereFields.map((field) => entry.where[field])];
      const result = await client.query(
        `UPDATE ${quote(spec.table)} SET ${quote(spec.tenantColumn)} = $1 ` +
          `WHERE ${predicates} AND ${quote(spec.tenantColumn)} IS NULL RETURNING 1`,
        values,
      );
      if (result.rowCount !== 1) {
        throw new Error(`mapping[${index}] matched ${result.rowCount} unresolved rows; expected exactly 1`);
      }
    }
    await client.query("COMMIT");
    process.stdout.write(`F-DB-05 tenant backfill: applied ${mappings.length} explicit mappings\n`);
    await printReport(client);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => fail(error.message));
