// scripts/backfill-profile-fields.mjs — backfill the profile demographic/contact
// fields + Employee Documents onto the EXISTING live dataset (does NOT wipe or
// recreate). Idempotent: only fills columns that are currently empty, and only
// creates documents for employees that have none. Writes go through the
// C4-extended prisma singleton so nationality_id_no is encrypted at rest.
//
// Anchored to the live tenant (RBAC Company 1 "Default Company"). Run in a
// node:24 pod with the real C4 keys + DB reachable.
import prisma from "../src/lib/prisma.js";
import { mcpCtx } from "../src/mcp/context.js";

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const daysAgo = (d) => new Date(Date.now() - d * 86400000);

const TENANT = "14c350e8-d0bc-4ee9-90c7-dea2b7a7a007"; // RBAC Company 1 "Default Company"

const CITY_META = {
  Karachi: { province: "Sindh", postal: "74000" },
  Lahore: { province: "Punjab", postal: "54000" },
  Islamabad: { province: "Islamabad Capital Territory", postal: "44000" },
};
const AREAS = ["Gulberg III","DHA Phase 5","Clifton Block 4","Bahria Town","Model Town","F-7 Markaz","Johar Town","North Nazimabad","Askari 10","G-11"];
const DOC_TYPES = [
  { title: "CNIC", category: "CNIC", mime: "image/jpeg", hasExpiry: true },
  { title: "Employment Contract", category: "Employment Contract", mime: "application/pdf", hasExpiry: false },
  { title: "Offer Letter", category: "Offer Letter", mime: "application/pdf", hasExpiry: false },
  { title: "Educational Certificate", category: "Educational Certificate", mime: "application/pdf", hasExpiry: false },
  { title: "Experience Letter", category: "Experience Letter", mime: "application/pdf", hasExpiry: false },
  { title: "Passport", category: "Passport", mime: "image/jpeg", hasExpiry: true },
];
const mkCnic = () => `${String(10000 + rnd(89999))}-${String(1000000 + rnd(8999999))}-${rnd(9)}`;

async function main() {
  const log = (m) => console.log(`[backfill] ${m}`);
  const emps = await prisma.employee.findMany({
    select: {
      id: true, first_name: true, last_name: true, employee_code: true, hire_date: true, joining_date: true,
      email: true, work_email: true, city: true,
      preferred_name: true, date_of_birth: true, nationality: true, nationality_id_no: true,
      nationality_id_type: true, marital_status: true, work_phone: true, personal_contact: true,
      current_address: true, permenant_address: true, state: true, province: true, postal_code: true,
      country: true, probation_end_date: true,
    },
  });
  log(`${emps.length} employees loaded`);

  let updated = 0, docCount = 0, docSkipped = 0;
  for (const e of emps) {
    const city = e.city && CITY_META[e.city] ? e.city : pick(Object.keys(CITY_META));
    const cm = CITY_META[city];
    const first = e.first_name || "Employee";
    const last = e.last_name || "";
    const residential = e.current_address || `House ${1 + rnd(400)}, Street ${1 + rnd(40)}, ${pick(AREAS)}, ${city}`;
    const join = e.joining_date || e.hire_date || daysAgo(365);

    // Build a patch containing ONLY empty columns (don't clobber real data).
    const data = {};
    const setIfEmpty = (k, cur, val) => { if (cur == null || cur === "") data[k] = val; };
    // Personal email distinct from work email (currently both were the same seeded value).
    if (!e.email || e.email === e.work_email) data.email = `${first}.${last}${rnd(9999)}@gmail.com`.toLowerCase();
    setIfEmpty("preferred_name", e.preferred_name, rnd(3) === 0 ? first : null);
    setIfEmpty("date_of_birth", e.date_of_birth, daysAgo(365 * (24 + rnd(33)) + rnd(365)));
    setIfEmpty("nationality", e.nationality, "Pakistani");
    setIfEmpty("nationality_id_type", e.nationality_id_type, "CNIC");
    setIfEmpty("nationality_id_no", e.nationality_id_no, mkCnic());
    setIfEmpty("marital_status", e.marital_status, pick(["Single","Married","Married"]));
    setIfEmpty("work_phone", e.work_phone, `+9221${String(rnd(9999999)).padStart(7,"0")}`);
    setIfEmpty("personal_contact", e.personal_contact, `+9230${rnd(9)}${String(rnd(9999999)).padStart(7,"0")}`);
    setIfEmpty("current_address", e.current_address, residential);
    setIfEmpty("permenant_address", e.permenant_address, residential);
    setIfEmpty("city", e.city, city);
    setIfEmpty("state", e.state, cm.province);
    setIfEmpty("province", e.province, cm.province);
    setIfEmpty("country", e.country, "Pakistan");
    setIfEmpty("postal_code", e.postal_code, cm.postal);
    setIfEmpty("probation_end_date", e.probation_end_date, new Date(new Date(join).getTime() + 90 * 86400000));

    if (Object.keys(data).length) { await prisma.employee.update({ where: { id: e.id }, data }); updated++; }

    // Documents — only if the employee has none.
    const existing = await prisma.employeeMedia.count({ where: { employee_id: e.id } });
    if (existing > 0) { docSkipped++; continue; }
    const mine = DOC_TYPES.filter((d) => {
      if (["CNIC","Employment Contract","Offer Letter","Educational Certificate"].includes(d.title)) return true;
      if (d.title === "Experience Letter") return Math.random() < 0.5;
      if (d.title === "Passport") return Math.random() < 0.3;
      return false;
    });
    for (const d of mine) {
      const status = Math.random() < 0.75 ? "verified" : "pending";
      const expiry = d.hasExpiry ? (Math.random() < 0.25 ? daysAgo(-(10 + rnd(80))) : daysAgo(-(200 + rnd(1500)))) : null;
      await prisma.employeeMedia.create({ data: {
        tenantId: TENANT, employee_id: e.id, title: d.title, category: d.category,
        version: "1", visibility: "hr", status,
        effective_date: new Date(join).toISOString().slice(0, 10),
        expiry_date: expiry ? expiry.toISOString().slice(0, 10) : null,
        file_name: `${d.title.replace(/\s+/g,"_").toLowerCase()}_${e.employee_code}.${d.mime === "application/pdf" ? "pdf" : "jpg"}`,
        mime_type: d.mime, file_size: 40000 + rnd(2000000),
        notes: status === "pending" ? "Awaiting HR verification" : null,
      } });
      docCount++;
    }
  }
  log(`DONE. employees patched: ${updated}, documents created: ${docCount}, employees with docs already: ${docSkipped}`);
}

mcpCtx.run({ user: { tenantId: TENANT } }, () => {
  main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async (e) => { console.error("BACKFILL ERROR:", e); await prisma.$disconnect(); process.exit(1); });
});
