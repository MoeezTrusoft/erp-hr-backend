import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";


export const enrollEmployee = async (data) => {
  if (!data.courseId || !data.employeeId)
    throw new Error("Course ID and Employee ID are required");

  const create = await prisma.trainingEnrollment.create({ data });
  await logAction({
    employeeId: 1,
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Training Enrollment",
    result: "SUCCESS",
    notes: `Training Enrollment"${create.id}" Created successfully`,
  });

  return create;
};

export const getEnrollments = async () => {
  return prisma.trainingEnrollment.findMany({
    include: { course: true, employee: true },
    orderBy: { id: "desc" },
  });
};

export const getEnrollmentById = async (id) => {
  const enrollment = await prisma.trainingEnrollment.findUnique({
    where: { id: Number(id) },
    include: { course: true, employee: true },
  });
  if (!enrollment) throw new Error("Enrollment not found");
  return enrollment;
};

export const updateEnrollment = async (id, data) => {
  const existing = await prisma.trainingEnrollment.findUnique({where: {id: Number(id)}})
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

export const deleteEnrollment = async (id) => {
  const existing = await prisma.trainingEnrollment.findUnique({where: {id: Number(id)}})
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


export const updateEnrollmentProgress = async (id, { progress }) => {
  if (progress === undefined || progress === null)
    throw new Error("Progress value is required");

  const parsedProgress = Number(progress);
  if (Number.isNaN(parsedProgress))
    throw new Error("Progress must be a number");

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
    await _maybeCompleteCourseIfAllEnrollmentsCompleted(updated.courseId);
  }

  return updated;
};

const _maybeCompleteCourseIfAllEnrollmentsCompleted = async (courseId) => {
  // fetch counts
  const [total, completed] = await Promise.all([
    prisma.trainingEnrollment.count({ where: { courseId: Number(courseId) } }),
    prisma.trainingEnrollment.count({
      where: { courseId: Number(courseId), status: "COMPLETED" },
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