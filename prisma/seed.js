/**
 * Prisma seed — mock employees + 30-day attendance
 * Run: npx prisma db seed
 *
 * employee_code matches K20 device user IDs (strings "1" – "12")
 * so the live listener can resolve employees from biometric punches.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

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

  console.log("\n🌱 Seeding leave policies, balances, and sample requests...");
  const policyDefs = [
    { name: "Annual Leave", leaveTypeCode: "ANNUAL", accrualRate: 48 },
    { name: "Sick Leave", leaveTypeCode: "SICK", accrualRate: 14 },
    { name: "Casual Leave", leaveTypeCode: "CASUAL", accrualRate: 24 },
  ];

  const policyIds = {};
  for (const policy of policyDefs) {
    const existingPolicy = await prisma.leavePolicy.findFirst({
      where: { leaveTypeCode: policy.leaveTypeCode },
    });
    policyIds[policy.leaveTypeCode] = existingPolicy
      ? existingPolicy.id
      : (
          await prisma.leavePolicy.create({
            data: {
              name: policy.name,
              leaveTypeCode: policy.leaveTypeCode,
              accrualRate: policy.accrualRate,
              active: true,
            },
          })
        ).id;
  }

  for (const employeeId of employeeIds) {
    for (const code of Object.keys(policyIds)) {
      const used = code === "ANNUAL" ? 18 : code === "SICK" ? 8 : 11;
      const total = code === "ANNUAL" ? 48 : code === "SICK" ? 14 : 24;
      await prisma.leaveBalance.upsert({
        where: {
          employeeId_leavePolicyId: {
            employeeId,
            leavePolicyId: policyIds[code],
          },
        },
        update: { balance: total - used },
        create: {
          employeeId,
          leavePolicyId: policyIds[code],
          balance: total - used,
        },
      });
    }
  }

  const sampleRequests = [
    { employeeId: employeeIds[0], policy: "ANNUAL", status: "PENDING" },
    { employeeId: employeeIds[1], policy: "SICK", status: "APPROVED" },
    { employeeId: employeeIds[3], policy: "CASUAL", status: "REJECTED" },
  ];

  const futureStart = new Date();
  futureStart.setDate(futureStart.getDate() + 14);
  const futureEnd = new Date(futureStart);
  futureEnd.setDate(futureEnd.getDate() + 4);

  for (const sample of sampleRequests) {
    const existingRequest = await prisma.leaveRequest.findFirst({
      where: {
        employeeId: sample.employeeId,
        leavePolicyId: policyIds[sample.policy],
        status: sample.status,
      },
    });
    if (existingRequest) continue;

    await prisma.leaveRequest.create({
      data: {
        employeeId: sample.employeeId,
        leavePolicyId: policyIds[sample.policy],
        startDate: futureStart,
        endDate: futureEnd,
        totalDays: 5,
        reason: "Seeded leave request",
        status: sample.status,
        createdById: sample.employeeId,
      },
    });
  }

  console.log("\n🌱 Seeding onboarding checklist...");
  const onboardingEmployeeId = employeeIds[5] || employeeIds[0];
  const buddyEmployeeId = employeeIds[1] || employeeIds[0];

  let checklist = await prisma.onboardingChecklist.findFirst({
    where: { employeeId: onboardingEmployeeId },
  });

  if (!checklist) {
    checklist = await prisma.onboardingChecklist.create({
      data: {
        employeeId: onboardingEmployeeId,
        title: "New Hire Onboarding",
        startDate: new Date(),
        targetDate: new Date(Date.now() + 30 * 86_400_000),
        status: "IN_PROGRESS",
      },
    });
  }

  const defaultTasks = [
    { title: "Documents received", assigneeType: "NEW_HIRE", completed: true, sortOrder: 1 },
    { title: "Complete personal information", assigneeType: "NEW_HIRE", completed: false, sortOrder: 2 },
    { title: "VPN access enabled", assigneeType: "IT", completed: false, sortOrder: 3 },
    { title: "Company email created", assigneeType: "NEW_HIRE", completed: true, sortOrder: 4 },
    { title: "System access assigned", assigneeType: "NEW_HIRE", completed: true, sortOrder: 5 },
    { title: "Communication tools setup", assigneeType: "IT", completed: false, sortOrder: 6 },
    { title: "Welcome email sent", assigneeType: "HR", completed: true, sortOrder: 7 },
    { title: "Intro video watched", assigneeType: "NEW_HIRE", completed: false, sortOrder: 8 },
    { title: "First-day agenda reviewed", assigneeType: "NEW_HIRE", completed: false, sortOrder: 9 },
    { title: "Laptop assigned", assigneeType: "IT", completed: true, sortOrder: 10 },
    { title: "ID card prepared", assigneeType: "HR", completed: false, sortOrder: 11 },
    { title: "Desk allocated", assigneeType: "HR", completed: false, sortOrder: 12 },
    { title: "Software installed", assigneeType: "IT", completed: false, sortOrder: 13 },
    { title: "Accessories allocated", assigneeType: "IT", completed: false, sortOrder: 14 },
    { title: "Orientation scheduled", assigneeType: "HR", completed: false, sortOrder: 15 },
    { title: "Welcome kit ready", assigneeType: "HR", completed: false, sortOrder: 16 },
  ];

  const existingTaskCount = await prisma.onboardingTask.count({
    where: { checklistId: checklist.id },
  });

  if (existingTaskCount === 0) {
    await prisma.onboardingTask.createMany({
      data: defaultTasks.map((task) => ({
        checklistId: checklist.id,
        title: task.title,
        assigneeType: task.assigneeType,
        completed: task.completed,
        completedAt: task.completed ? new Date() : null,
        sortOrder: task.sortOrder,
      })),
    });
  }

  await prisma.onboardingBuddy.upsert({
    where: { checklistId: checklist.id },
    update: { buddyId: buddyEmployeeId },
    create: { checklistId: checklist.id, buddyId: buddyEmployeeId },
  });

  const overtimeRule = await prisma.overtimeRule.findFirst();
  if (!overtimeRule) {
    await prisma.overtimeRule.create({
      data: {
        name: "Standard Overtime Policy",
        description: "Direct manager approval required",
        daily_hours_threshold: 8,
        weekly_hours_threshold: 40,
        daily_overtime_rate: 1.5,
        weekly_overtime_rate: 1.5,
        max_hours_per_day: 20,
        max_hours_per_week: 8,
        is_active: true,
      },
    });
  }

  // Seed Work Schedules for employees
  const employees = await prisma.employee.findMany({ take: 3 });
  const existingSchedules = await prisma.workSchedule.count();

  if (existingSchedules === 0 && employees.length > 0) {
    const today = new Date();
    const nextYear = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());

    // Morning shift (9 AM - 5 PM)
    if (employees[0]) {
      await prisma.workSchedule.create({
        data: {
          employeeId: employees[0].id,
          schedule_name: "Morning Shift",
          effective_start_date: today,
          effective_end_date: nextYear,
          total_hours_per_week: 40,
          schedule_pattern: {
            shift_start: "09:00",
            shift_end: "17:00",
            days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
            break_duration: 60,
          },
          overtimeRuleId: overtimeRule?.id,
        },
      });
    }

    // Afternoon shift (2 PM - 10 PM)
    if (employees[1]) {
      await prisma.workSchedule.create({
        data: {
          employeeId: employees[1].id,
          schedule_name: "Afternoon Shift",
          effective_start_date: today,
          effective_end_date: nextYear,
          total_hours_per_week: 40,
          schedule_pattern: {
            shift_start: "14:00",
            shift_end: "22:00",
            days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
            break_duration: 60,
          },
          overtimeRuleId: overtimeRule?.id,
        },
      });
    }

    // Night shift (10 PM - 6 AM)
    if (employees[2]) {
      await prisma.workSchedule.create({
        data: {
          employeeId: employees[2].id,
          schedule_name: "Night Shift",
          effective_start_date: today,
          effective_end_date: nextYear,
          total_hours_per_week: 40,
          schedule_pattern: {
            shift_start: "22:00",
            shift_end: "06:00",
            days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
            break_duration: 60,
          },
          overtimeRuleId: overtimeRule?.id,
        },
      });
    }
  }

  console.log("\n✅ Seed complete.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
