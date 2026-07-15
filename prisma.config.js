// Prisma 7 configuration (replaces the removed `package.json#prisma` key and
// the schema `datasource.url`). ESM, no TypeScript — matches this repo's style.
// Prisma 7 no longer auto-loads .env, so we load it explicitly for CLI commands
// (migrate / db push / studio). At app runtime the connection is driven by the
// driver adapter in src/lib/prisma.js.
import path from "node:path";
import "dotenv/config";

export default {
  schema: path.join("prisma", "schema.prisma"),
  migrations: { path: path.join("prisma", "migrations") },
  datasource: { url: process.env.DATABASE_URL },
};
