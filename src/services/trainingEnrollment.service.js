import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const enrollEmployee = async (data) => {
  if (!data.courseId || !data.employeeId)
    throw new Error("Course ID and Employee ID are required");

  return prisma.trainingEnrollment.create({ data });
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
  return prisma.trainingEnrollment.update({
    where: { id: Number(id) },
    data,
  });
};

export const deleteEnrollment = async (id) => {
  return prisma.trainingEnrollment.delete({ where: { id: Number(id) } });
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