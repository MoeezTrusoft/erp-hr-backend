import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { uploadFileToDAM } from "./dam.media.service.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2 — verified tenant (T-P2.1) threaded in as a trailing `tenantId`; folded
// into training-course reads and stamped on creates, fail-closed when present.

export const createCourse = async (data, tenantId) => {
  if (!data.title) throw new Error("Course title is required");
  if (!data.categoryId) throw new Error("Category ID is required");

  const create = await prisma.trainingCourse.create({ data: scopedData(tenantId, { ...data }) });
  await logAction({
    employeeId: 1,
    type: "Create",
    module: "Training Course",
    result: "SUCCESS",
    notes: `Training Course\"${create.id}\" created successfully`,
  });

  return create;
};

export const getAllCourses = async (tenantId) => {
  return prisma.trainingCourse.findMany({
    where: scopedWhere(tenantId, {}),
    include: {
      category: true,
      instructor: true,
      enrollments: true,
      sessions: true,
      pathCourses: true,
      certifications: true,
    },
    orderBy: { id: "desc" },
  });
};

export const getCourseById = async (id, tenantId) => {
  const course = await prisma.trainingCourse.findFirst({
    where: scopedWhere(tenantId, { id: Number(id) }),
    include: {
      category: true,
      instructor: true,
      enrollments: { include: { employee: true } },
      sessions: true,
      pathCourses: true,
      certifications: true,
    },
  });
  if (!course) throw new Error("Course not found");
  return course;
};

export const updateCourse = async (id, data, tenantId) => {
  const existing = await prisma.trainingCourse.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Course not found");
  const update = await prisma.trainingCourse.update({
    where: { id: Number(id) },
    data,
  });

  await logAction({
    employeeId: 1,
    type: "Update",
    module: "Training Course",
    result: "SUCCESS",
    notes: `Training Course\"${id}\" updated successfully`,
  });

  return update;
};

export const deleteCourse = async (id, tenantId) => {
  const existing = await prisma.trainingCourse.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error(`Course not found Id${id}`);

  const deleted = await prisma.trainingCourse.delete({ where: { id: Number(id) } });

  await logAction({
    employeeId: 1,
    type: "Delete",
    module: "Training Course",
    result: "SUCCESS",
    notes: `Training Course\"${id}\" deleted successfully`,
  });
  return deleted;
};

export const uploadCourseMaterial = async (id, file, tenantId) => {
  const existing = await prisma.trainingCourse.findFirst({ where: scopedWhere(tenantId, { id: Number(id) }) });
  if (!existing) throw new Error("Course not found");
  const uploaded = await uploadFileToDAM(file, "document");
  if (!uploaded || !uploaded[0]) throw new Error("DAM upload failed");

  return prisma.trainingCourse.update({
    where: { id: Number(id) },
    data: { contentMediaId: uploaded[0].id },
  });
};

export const getUpcomingCourses = async ({ days = 30, limit = 50, offset = 0, tenantId } = {}) => {
  const now = new Date();
  const future = new Date();
  future.setDate(now.getDate() + Number(days));

  return prisma.trainingCourse.findMany({
    where: scopedWhere(tenantId, {
      startDate: { gte: now, lte: future },
      status: "ACTIVE",
    }),
    include: { category: true, instructor: true },
    orderBy: { startDate: "asc" },
    take: Number(limit),
    skip: Number(offset),
  });
};

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

export const getGlobalAnalyticsOverview = async () => {
  const totalCourses = await prisma.trainingCourse.count();
  const activeCourses = await prisma.trainingCourse.count({ where: { status: "ACTIVE" } });
  const totalEnrollments = await prisma.trainingEnrollment.count();

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
