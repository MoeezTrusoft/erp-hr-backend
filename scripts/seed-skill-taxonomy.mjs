// scripts/seed-skill-taxonomy.mjs
//
// Phase 13/§7.2 — seed the canonical Skill catalogue + alias layer so the
// taxonomy-anchored matching resolves real resume skills from day one.
//
// Idempotent: existing Skills are re-used by (tenantId, name); aliases are
// upserted by (tenantId, alias). Aliases marked origin 'seed' (manual family)
// and point at canonical ids. Platform scope (tenantId NULL) is NOT written
// here — §7.2b puts the platform core under platform/product ownership, so
// this script only curates TENANT scope by default.
//
// Usage:
//   node --env-file=.env scripts/seed-skill-taxonomy.mjs [--tenant <uuid>] [--dry-run]
// Default tenant: the seed-prod tenant (RBAC Company 2 uuid).

import process from "node:process";
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const args = process.argv.slice(2);
const tenantArg = args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : null;
const DRY_RUN = args.includes("--dry-run");
const TENANT = tenantArg ?? "066dd015-2820-47b5-b2fc-1e9704f0f420"; // RBAC Company 2 (seed-prod)

// Canonical catalogue: the seed-prod base plus the skills observed in the
// hr-data/recruitment/resume-parsings fixture corpus (live parse, 2026-09-21).
const CATALOGUE = [
    // from seed-prod base
    "JavaScript", "Node.js", "React", "PostgreSQL", "Kubernetes", "Docker",
    "Python", "TypeScript", "AWS", "GraphQL", "Salesforce", "Financial Modeling",
    "Excel", "SEO", "Copywriting", "Data Analysis", "Project Management",
    "Recruiting", "Payroll", "Negotiation",
    // from the fixture corpus (all four resumes)
    "Next.js", "Three.js", "Tailwind CSS", "Bootstrap", "Express.js", "React.js",
    "HTML/CSS", "HTML", "CSS", "SQL", "MySQL", "C", "C++", "C#", "Java",
    "ASP.NET Core", "REST API", "Git", "Version Control", "Linux Server Administration",
    "CI/CD Pipelines", "Azure", "Shopify Development", "Database Management",
    "Network Configuration", "Technical Support", "Java",
];

// Alias → canonical. Aliases seen in raw resumes/AI output that must resolve.
const ALIASES = {
    JS: "JavaScript",
    "Javascript": "JavaScript",
    "java script": "JavaScript",
    "Nodejs": "Node.js",
    "Node JS": "Node.js",
    "Reactjs": "React.js",
    "React.js": "React", // canonical catalogue entry is "React"
    "NextJS": "Next.js",
    "Next JS": "Next.js",
    "Postgres": "PostgreSQL",
    "postgres sql": "PostgreSQL",
    "K8s": "Kubernetes",
    "TS": "TypeScript",
    "Golang": "Go",
    "HTML5": "HTML",
    "CSS3": "CSS",
    "html/css": "HTML/CSS",
    "Express": "Express.js",
    "ExpressJS": "Express.js",
    "Amazon Web Services": "AWS",
    "MS Excel": "Excel",
    "Microsoft Excel": "Excel",
    "Continuous Integration": "CI/CD Pipelines",
    "CICD": "CI/CD Pipelines",
    "Github": "Git",
    "version control systems": "Version Control",
};

if (!DRY_RUN && !process.argv.includes("--yes")) {
    console.error("Refusing to write without --yes (or --dry-run for a report).");
    process.exit(2);
}

const result = await mcpCtx.run({ user: { tenantId: TENANT, isAdmin: true } }, async () => {
    let created = 0, existing = 0, aliasCreated = 0, aliasUpdated = 0;
    const report = { skillsCreated: [], aliasesCreated: [], aliasesUpdated: [] };

    const canonicalIds = {};
    for (const name of [...new Set(CATALOGUE)]) {
        const found = await prisma.skill.findFirst({ where: { name, tenantId: TENANT } });
        if (found) {
            canonicalIds[name] = found.id;
            existing += 1;
            continue;
        }
        if (DRY_RUN) {
            report.skillsCreated.push(name);
            continue;
        }
        const row = await prisma.skill.create({ data: { name, category: "skill", tenantId: TENANT } });
        canonicalIds[name] = row.id;
        created += 1;
        report.skillsCreated.push(name);
    }

    // "Go" is referenced by an alias but not in the fixture catalogue; create it
    // so the alias does not dangle.
    if (ALIASES.Golang && !canonicalIds.Go && !DRY_RUN) {
        const row = await prisma.skill.create({ data: { name: "Go", category: "skill", tenantId: TENANT } });
        canonicalIds.Go = row.id;
        created += 1;
        report.skillsCreated.push("Go");
    }

    for (const [alias, canonical] of Object.entries(ALIASES)) {
        const skillId = canonicalIds[canonical];
        if (!skillId) {
            if (!DRY_RUN) {
                // Canonical missing in this tenant — create it lazily so the alias resolves.
                const row = await prisma.skill.create({ data: { name: canonical, category: "skill", tenantId: TENANT } });
                canonicalIds[canonical] = row.id;
                created += 1;
            } else {
                continue;
            }
        }
        const target = canonicalIds[canonical];
        const dup = await prisma.skillAlias.findUnique({
            where: { tenantId_alias: { tenantId: TENANT, alias } },
        });
        if (dup) {
            if (dup.skillId !== target) {
                if (!DRY_RUN) await prisma.skillAlias.update({ where: { id: dup.id }, data: { skillId: target } });
                aliasUpdated += 1;
                report.aliasesUpdated.push(`${alias} → ${canonical}`);
            }
            continue;
        }
        if (!DRY_RUN) {
            await prisma.skillAlias.create({
                data: { alias, skillId: target, scope: "TENANT", origin: "manual", status: "ACTIVE", tenantId: TENANT },
            });
        }
        aliasCreated += 1;
        report.aliasesCreated.push(`${alias} → ${canonical}`);
    }

    return { created, existing, aliasCreated, aliasUpdated, ...report };
});

console.log(`tenant: ${TENANT}`);
console.log(`skills: ${result.created} created, ${result.existing} existing`);
console.log(`aliases: ${result.aliasCreated} created, ${result.aliasUpdated} updated`);
if (result.skillsCreated?.length) console.log("new skills:", result.skillsCreated.join(", "));
if (result.aliasesUpdated?.length) console.log("re-pointed:", result.aliasesUpdated.join(", "));
console.log(result.created + result.aliasCreated > 0 ? "taxonomy seeded" : "taxonomy already current");
process.exit(0);
