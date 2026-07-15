// scripts/backfill-workmode-emergency-positions.mjs — populate the newly-added
// columns + emergency contacts on the live tenant. Idempotent: only fills empty
// work_mode / position columns, and only creates emergency contacts for
// employees that have none. Anchored to RBAC Company 1. Run in a node:24 pod
// with the NEW prisma client (knows Employee.work_mode + Position.band/…).
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007";
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

const WORK_MODES = ["Onsite", "Onsite", "Hybrid", "Hybrid", "Remote"]; // weighted
const BANDS = ["Band A — Entry", "Band B — Associate", "Band C — Professional", "Band D — Senior", "Band E — Lead"];
const REL = ["Spouse", "Father", "Mother", "Sibling", "Friend"];
const EC_FIRST = ["Ahmed", "Ali", "Sara", "Fatima", "Bilal", "Hina", "Usman", "Ayesha", "Kamran", "Nadia"];
const EC_LAST = ["Khan", "Malik", "Sheikh", "Butt", "Raza", "Hussain", "Iqbal", "Farooq"];

const respFor = (title) => [
  `Own and deliver ${title} outcomes end-to-end.`,
  "Collaborate cross-functionally with stakeholders.",
  "Uphold quality, security and delivery standards.",
].join("\n");
const reqFor = (title) => [
  "Relevant degree or equivalent experience.",
  `3+ years in a ${title} or adjacent role.`,
  "Strong communication and ownership.",
].join("\n");

async function main() {
  const log = (m) => console.log(`[wme-backfill] ${m}`);

  // ---------- work_mode on employees (only where empty) ----------
  const emps = await prisma.employee.findMany({ select: { id: true, work_mode: true, first_name: true, last_name: true } });
  let wm = 0;
  for (const e of emps) {
    if (e.work_mode == null || e.work_mode === "") {
      await prisma.employee.update({ where: { id: e.id }, data: { work_mode: pick(WORK_MODES) } });
      wm++;
    }
  }
  log(`work_mode set on ${wm}/${emps.length} employees`);

  // ---------- band / responsibilities / requirements on positions ----------
  const positions = await prisma.position.findMany({ select: { id: true, title: true, band: true, responsibilities: true, requirements: true } });
  let pc = 0;
  for (const p of positions) {
    const data = {};
    if (p.band == null || p.band === "") data.band = pick(BANDS);
    if (p.responsibilities == null || p.responsibilities === "") data.responsibilities = respFor(p.title);
    if (p.requirements == null || p.requirements === "") data.requirements = reqFor(p.title);
    if (Object.keys(data).length) { await prisma.position.update({ where: { id: p.id }, data }); pc++; }
  }
  log(`band/responsibilities/requirements set on ${pc}/${positions.length} positions`);

  // ---------- emergency contacts (only for employees with none) ----------
  let ec = 0, ecSkip = 0;
  for (const e of emps) {
    const existing = await prisma.emergencyContacts.count({ where: { employee_Id: e.id } });
    if (existing > 0) { ecSkip++; continue; }
    const n = 1 + rnd(2); // 1 or 2 contacts
    for (let i = 0; i < n; i++) {
      const name = `${pick(EC_FIRST)} ${e.last_name || pick(EC_LAST)}`;
      await prisma.emergencyContacts.create({ data: {
        Contact_name: name,
        relationship: pick(REL),
        phone: `+9230${rnd(9)}${String(rnd(9999999)).padStart(7, "0")}`,
        email: `${name.replace(/\s+/g, ".").toLowerCase()}${rnd(99)}@example.com`,
        is_primary: i === 0,
        employee_Id: e.id,
        tenantId: TENANT,
      } });
      ec++;
    }
  }
  log(`emergency contacts created: ${ec} (employees already having some: ${ecSkip})`);
  log("DONE.");
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => {
    console.error("WME-BACKFILL ERROR:", e); await prisma.$disconnect(); process.exit(1);
  });
});
