import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const createCourse = async (data) => {
  if (!data.title) throw new Error("Course title is required");
  if (!data.categoryId) throw new Error("Category ID is required");

  return prisma.trainingCourse.create({ data });
};

export const getAllCourses = async () => {
  return prisma.trainingCourse.findMany({
    include: {
      category: true,
      instructor: true,
      enrollments: true,
    },
    orderBy: { id: "desc" },
  });
};

export const getCourseById = async (id) => {
  const course = await prisma.trainingCourse.findUnique({
    where: { id: Number(id) },
    include: {
      category: true,
      instructor: true,
      enrollments: { include: { employee: true } },
    },
  });
  if (!course) throw new Error("Course not found");
  return course;
};

export const updateCourse = async (id, data) => {
  return prisma.trainingCourse.update({
    where: { id: Number(id) },
    data,
  });
};

export const deleteCourse = async (id) => {
  return prisma.trainingCourse.delete({ where: { id: Number(id) } });
};

/**
 * Upcoming courses within next `days` days (default 30)
 * Only returns courses with startDate defined and status ACTIVE by default.
 */
export const getUpcomingCourses = async ({ days = 30, limit = 50, offset = 0 } = {}) => {
  const now = new Date();
  const future = new Date();
  future.setDate(now.getDate() + Number(days));

  return prisma.trainingCourse.findMany({
    where: {
      startDate: { gte: now, lte: future },
      status: "ACTIVE",
    },
    include: { category: true, instructor: true },
    orderBy: { startDate: "asc" },
    take: Number(limit),
    skip: Number(offset),
  });
};

/**
 * Course analytics: enrollmentCount, completedCount, completionRate, avgProgress
 */
export const getCourseAnalytics = async (courseId) => {
  const id = Number(courseId);

  const enrollmentCount = await prisma.trainingEnrollment.count({ where: { courseId: id } });
  const completedCount = await prisma.trainingEnrollment.count({
    where: { courseId: id, status: "COMPLETED" },
  });

  const avgProgressAgg = await prisma.trainingEnrollment.aggregate({
    where: { courseId: id },
    _avg: { progress: true },
  });

  const avgProgress = avgProgressAgg._avg.progress ?? 0;
  const completionRate = enrollmentCount === 0 ? 0 : (completedCount / enrollmentCount) * 100;

  return {
    courseId: id,
    enrollmentCount,
    completedCount,
    completionRate: Number(completionRate.toFixed(2)),
    avgProgress: Number(Number(avgProgress).toFixed(2)),
  };
};

/**
 * Global analytics overview
 */
export const getGlobalAnalyticsOverview = async () => {
  const totalCourses = await prisma.trainingCourse.count();
  const activeCourses = await prisma.trainingCourse.count({ where: { status: "ACTIVE" } });
  const totalEnrollments = await prisma.trainingEnrollment.count();

  // compute overall completion rate
  const completedEnrollments = await prisma.trainingEnrollment.count({
    where: { status: "COMPLETED" },
  });

  const overallCompletionRate =
    totalEnrollments === 0 ? 0 : (completedEnrollments / totalEnrollments) * 100;

  return {
    totalCourses,
    activeCourses,
    totalEnrollments,
    completedEnrollments,
    overallCompletionRate: Number(overallCompletionRate.toFixed(2)),
  };
};