import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded in via `tenantId` (inside
// the create `data`, or a trailing read/update/delete param); folded into
// enrollment reads/writes fail-closed so tenant B never touches tenant A's data.

export const enrollEmployee = async (data) => {
  if (!data.courseId || !data.employeeId)
    throw new Error("Course ID and Employee ID are required");

  const { tenantId, ...rest } = data;
  const create = await prisma.trainingEnrollment.create({ data: scopedData(tenantId, rest) });
  await logAction({
    employeeId: 1,
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Training Enrollment",
    result: "SUCCESS",
    notes: `Training Enrollment"${create.id}" Created successfully`,
  });

  return create;
};

export const getEnrollments = async (tenantId) => {
  return prisma.trainingEnrollment.findMany({
    where: scopedWhere(tenantId, {}),
    include: { course: true, employee: true },
    orderBy: { id: "desc" },
  });
};

export const getEnrollmentById = async (id, tenantId) => {
  const enrollment = await prisma.trainingEnrollment.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: { course: true, employee: true },
  });
  if (!enrollment) throw new Error("Enrollment not found");
  return enrollment;
};

export const updateEnrollment = async (id, data, tenantId) => {
  const existing = await prisma.trainingEnrollment.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) })
  if(!existing) throw new Error(`Enrollment not Found ${id}`);
  
  const update = await prisma.trainingEnrollment.update({
    where: { id: Number(id) },
    data,
  });
  await logAction({
    employeeId: 1,
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Training Enrollment",
    result: "SUCCESS",
    notes: `Training Enrollment"${id}" Updated successfully`,
  });


  return update
};

export const deleteEnrollment = async (id, tenantId) => {
  const existing = await prisma.trainingEnrollment.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) })
  if(!existing) throw new Error(`Enrollment not Fount ${id}`);
  
  const deleted= await prisma.trainingEnrollment.delete({ where: { id: Number(id) } });
     await logAction({
    employeeId: 1,
    type: "Deleted", // 👈 changed from CREATE to UPDATE
    module: "Training Enrollment",
    result: "SUCCESS",
    notes: `Training Enrollment"${id}" Deleted Successfully`,
  });

  return deleted;
};


export const updateEnrollmentProgress = async (id, { progress }, tenantId) => {
  if (progress === undefined || progress === null)
    throw new Error("Progress value is required");

  const parsedProgress = Number(progress);
  if (Number.isNaN(parsedProgress))
    throw new Error("Progress must be a number");

  const existing = await prisma.trainingEnrollment.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error(`Enrollment not Found ${id}`);

  // clamp
  const clamped = Math.max(0, Math.min(100, parsedProgress));

  // determine status
  const status = clamped >= 100 ? "COMPLETED" : clamped > 0 ? "IN_PROGRESS" : "ENROLLED";

  const data = {
    progress: clamped,
    status,
    ...(clamped >= 100 ? { completionDate: new Date() } : { completionDate: null }),
  };

  const updated = await prisma.trainingEnrollment.update({
    where: { id: Number(id) },
    data,
    include: { course: true, employee: true },
  });

  // after updating enrollment, check if all enrollments for course are completed
  if (updated.courseId) {
    await _maybeCompleteCourseIfAllEnrollmentsCompleted(updated.courseId, tenantId);
  }

  return updated;
};

const _maybeCompleteCourseIfAllEnrollmentsCompleted = async (courseId, tenantId) => {
  // fetch counts
  const [total, completed] = await Promise.all([
    prisma.trainingEnrollment.count({ where: scopedWhere(tenantId, { courseId: Number(courseId) }) }),
    prisma.trainingEnrollment.count({
      where: scopedWhere(tenantId, { courseId: Number(courseId), status: "COMPLETED" }),
    }),
  ]);

  if (total > 0 && completed === total) {
    // mark course completed if not already
    await prisma.trainingCourse.update({
      where: { id: Number(courseId) },
      data: { status: "COMPLETED", updatedAt: new Date() },
    });
  }
};