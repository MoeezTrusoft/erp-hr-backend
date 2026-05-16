/**
 * Prisma seed — mock employees + 30-day attendance
 * Run: npx prisma db seed
 *
 * employee_code matches K20 device user IDs (strings "1" – "12")
 * so the live listener can resolve employees from biometric punches.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── helpers ──────────────────────────────────────────────────────────────────
function rndInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function addMinutes(date, mins) {
  return new Date(date.getTime() + mins * 60_000);
}

function setTime(date, h, m) {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

function isWeekday(date) {
  const d = date.getDay();
  return d !== 0 && d !== 6;
}

// ── employee data ─────────────────────────────────────────────────────────────
const EMPLOYEES = [
  { code: "1",  name: "Ahmed Raza",       title: "Software Engineer",       dept: "Engineering" },
  { code: "2",  name: "Fatima Khan",      title: "HR Manager",              dept: "Human Resources" },
  { code: "3",  name: "Bilal Hussain",    title: "Senior Developer",        dept: "Engineering" },
  { code: "4",  name: "Ayesha Siddiqui", title: "Business Analyst",        dept: "Operations" },
  { code: "5",  name: "Usman Tariq",      title: "DevOps Engineer",         dept: "Engineering" },
  { code: "6",  name: "Sana Malik",       title: "UI/UX Designer",          dept: "Design" },
  { code: "7",  name: "Zain Ali",         title: "Product Manager",         dept: "Product" },
  { code: "8",  name: "Hira Noor",        title: "QA Engineer",             dept: "Quality Assurance" },
  { code: "9",  name: "Kamran Sheikh",    title: "Finance Analyst",         dept: "Finance" },
  { code: "10", name: "Rabia Bashir",     title: "Marketing Specialist",    dept: "Marketing" },
  { code: "11", name: "Omer Javed",       title: "Backend Developer",       dept: "Engineering" },
  { code: "12", name: "Nadia Farooq",     title: "Operations Coordinator",  dept: "Operations" },
];

// ── seed ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🌱 Seeding employees...");

  const employeeIds = [];

  for (const emp of EMPLOYEES) {
    const existing = await prisma.employee.findFirst({
      where: { employee_code: emp.code },
    });

    let employee;
    if (existing) {
      console.log(`  ↩  Employee ${emp.code} (${emp.name}) already exists — skipping`);
      employee = existing;
    } else {
      employee = await prisma.employee.create({
        data: {
          employee_code:     emp.code,
          employee_name:     emp.name,
          job_title:         emp.title,
          status:            "active",
          employement_status:"Active",
          joining_date:      new Date("2023-01-15"),
          employee_type:     "permanent",
          remarks:           `Seeded – ${emp.dept}`,
        },
      });
      console.log(`  ✅ Created employee ${emp.code}: ${emp.name}`);
    }

    employeeIds.push(employee.id);
  }

  console.log("\n🌱 Seeding attendance (last 30 days)...");

  const today = new Date();
  let created = 0;
  let skipped = 0;

  for (let daysAgo = 30; daysAgo >= 0; daysAgo--) {
    const workDate = new Date(today);
    workDate.setDate(today.getDate() - daysAgo);
    workDate.setHours(0, 0, 0, 0);

    if (!isWeekday(workDate)) continue;

    for (let i = 0; i < employeeIds.length; i++) {
      const employeeId = employeeIds[i];

      // Randomly absent ~10% of days
      if (Math.random() < 0.1) continue;

      // check_in: 08:00 – 09:30
      const checkInMinuteOffset = rndInt(0, 90);
      const checkIn = setTime(workDate, 8, checkInMinuteOffset);

      // check_out: 17:00 – 18:30
      const checkOutMinuteOffset = rndInt(0, 90);
      const checkOut = setTime(workDate, 17, checkOutMinuteOffset);

      const diffMs = checkOut - checkIn;
      const totalHours = parseFloat((diffMs / 3_600_000).toFixed(2));

      // LATE if check_in after 09:00
      const status = checkIn.getHours() >= 9 && checkIn.getMinutes() > 0
        ? "LATE"
        : "PRESENT";

      const existing = await prisma.attendance.findFirst({
        where: {
          employeeId,
          date: {
            gte: workDate,
            lt:  new Date(workDate.getTime() + 86_400_000),
          },
        },
      });

      if (existing) {
        skipped++;
        continue;
      }

      await prisma.attendance.create({
        data: {
          employeeId,
          date:        workDate,
          check_in:    checkIn,
          check_out:   checkOut,
          total_hours: totalHours,
          status,
        },
      });
      created++;
    }
  }

  console.log(`  ✅ ${created} attendance records created, ${skipped} skipped (already existed)`);
  console.log("\n✅ Seed complete.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
