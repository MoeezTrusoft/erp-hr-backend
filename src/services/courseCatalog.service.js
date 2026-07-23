// src/services/courseCatalog.service.js
//
// Course Catalog (LMS) read/write model. Powers the FE course-catalog browse
// screen (search + category sidebar), the course-view detail page (sections /
// lectures / outcomes / reviews), lecture video playback (via DAM), enrollment,
// reviews (with denormalized rating rollup), and the section/lecture/outcome
// authoring surface.
//
// Tenancy/RLS: TrainingCourse, TrainingEnrollment, CourseSection, CourseLecture,
// CourseOutcome, CourseReview are all under Postgres FORCE ROW LEVEL SECURITY.
//   • READS fold the verified tenant into `where` via scopedWhere(tenantId, ...).
//   • Single-statement writes run under the ambient MCP RLS extension (which sets
//     the tenant GUC) so they need no explicit tenantTransaction; the DB column
//     DEFAULT hr_current_tenant() stamps tenantId on create.
//   • Multi-statement flows (createReview: insert + recompute + update) run inside
//     ONE tenantTransaction so every statement shares the tenant GUC.
// Singleton prisma per ARCH-01 §5.3–5.4.
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { getDamAssetById } from "./dam.media.service.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Sort key → prisma orderBy. `newest` is the default.
const SORT_ORDER_BY = {
  newest: { createdAt: "desc" },
  oldest: { createdAt: "asc" },
  title_asc: { title: "asc" },
  title_desc: { title: "desc" },
  rating: { ratingAvg: "desc" },
  popular: { ratingCount: "desc" },
};

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function roundMinutes(seconds) {
  return Math.round((Number(seconds) || 0) / 60);
}

// Build the shared catalog filter (everything EXCEPT the categoryId narrowing),
// so listCourseCatalog can reuse it for the sidebar counts that must ignore the
// active category. tenantId is folded by the caller via scopedWhere.
function buildCatalogFilter({ q, mode, tag }) {
  const where = {};
  if (q && String(q).trim()) {
    const term = String(q).trim();
    where.OR = [
      { title: { contains: term, mode: "insensitive" } },
      { courseCode: { contains: term, mode: "insensitive" } },
      { subtitle: { contains: term, mode: "insensitive" } },
    ];
  }
  if (mode) where.mode = mode;
  if (tag) where.tags = { has: tag };
  return where;
}

/**
 * Paginated catalog list with category-sidebar counts.
 * @returns {Promise<{ items, total, page, pageSize, categoryCounts }>}
 */
export async function listCourseCatalog({
  tenantId,
  q,
  categoryId,
  mode,
  tag,
  sort = "newest",
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
} = {}) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const skip = (safePage - 1) * safePageSize;

  // Filter WITHOUT the category narrowing — used for the sidebar counts so every
  // category shows its count under the current search. The list query adds the
  // category filter on top.
  const baseFilter = buildCatalogFilter({ q, mode, tag });
  const listFilter = { ...baseFilter, ...(categoryId != null ? { categoryId: Number(categoryId) } : {}) };

  const listWhere = scopedWhere(tenantId, listFilter);
  const countWhere = scopedWhere(tenantId, baseFilter);
  const orderBy = SORT_ORDER_BY[sort] || SORT_ORDER_BY.newest;

  const [rows, total, groups] = await Promise.all([
    prisma.trainingCourse.findMany({
      where: listWhere,
      include: {
        category: true,
        _count: { select: { enrollments: true } },
      },
      orderBy,
      skip,
      take: safePageSize,
    }),
    prisma.trainingCourse.count({ where: listWhere }),
    prisma.trainingCourse.groupBy({
      by: ["categoryId"],
      where: countWhere,
      _count: true,
    }),
  ]);

  // Resolve category names for the sidebar. groupBy yields categoryId (may be
  // null) + count; join to TrainingCategory names.
  const categoryIds = groups.map((g) => g.categoryId).filter((id) => id != null);
  const categories = categoryIds.length
    ? await prisma.trainingCategory.findMany({
        where: scopedWhere(tenantId, { id: { in: categoryIds } }),
      })
    : [];
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const categoryCounts = groups.map((g) => ({
    categoryId: g.categoryId,
    name: g.categoryId != null ? (nameById.get(g.categoryId) ?? null) : null,
    count: typeof g._count === "number" ? g._count : (g._count?._all ?? 0),
  }));

  const items = rows.map((c) => ({
    id: c.id,
    courseCode: c.courseCode ?? null,
    title: c.title,
    subtitle: c.subtitle ?? null,
    mode: c.mode,
    category: c.category ? { id: c.category.id, name: c.category.name } : null,
    tags: c.tags ?? [],
    addedAt: c.createdAt,
    ratingAvg: c.ratingAvg,
    ratingCount: c.ratingCount,
    enrolledCount: c._count?.enrollments ?? 0,
  }));

  return { items, total, page: safePage, pageSize: safePageSize, categoryCounts };
}

/**
 * Full course-view detail. 404s when the course is not in the caller's tenant.
 */
export async function getCourseDetail({ tenantId, id } = {}) {
  const courseId = Number(id);
  const course = await prisma.trainingCourse.findFirst({
    where: scopedWhere(tenantId, { id: courseId }),
    include: {
      category: true,
      createdBy: true,
      outcomes: { orderBy: { sortOrder: "asc" } },
      sections: {
        orderBy: { sortOrder: "asc" },
        include: { lectures: { orderBy: { sortOrder: "asc" } } },
      },
      _count: { select: { enrollments: true } },
    },
  });

  if (!course) {
    throw Object.assign(new Error("Course not found"), { status: 404 });
  }

  // Intro video: fetch DAM metadata fail-soft AFTER the main query.
  let introVideo = null;
  if (course.introVideoMediaId != null) {
    try {
      introVideo = await getDamAssetById(course.introVideoMediaId);
    } catch {
      introVideo = null;
    }
  }

  // Employee name columns are snake_case (first_name/last_name) with a
  // denormalized employee_name; prefer the latter, fall back to the parts.
  const createdBy = course.createdBy
    ? {
        id: course.createdBy.id,
        name:
          course.createdBy.employee_name ||
          `${course.createdBy.first_name ?? ""} ${course.createdBy.last_name ?? ""}`.trim(),
      }
    : null;

  const sections = (course.sections ?? []).map((s) => {
    const lectures = s.lectures ?? [];
    const totalSeconds = lectures.reduce((sum, l) => sum + (Number(l.durationSeconds) || 0), 0);
    return {
      id: s.id,
      title: s.title,
      lectureCount: lectures.length,
      totalMinutes: roundMinutes(totalSeconds),
      lectures: lectures.map((l) => ({
        id: l.id,
        title: l.title,
        durationSeconds: l.durationSeconds,
        durationMinutes: roundMinutes(l.durationSeconds),
        isPreview: l.isPreview,
      })),
    };
  });

  return {
    id: course.id,
    courseCode: course.courseCode ?? null,
    title: course.title,
    subtitle: course.subtitle ?? null,
    description: course.description ?? null,
    category: course.category ? { id: course.category.id, name: course.category.name } : null,
    mode: course.mode,
    language: course.language ?? null,
    introVideoMediaId: course.introVideoMediaId ?? null,
    introVideo,
    ratingAvg: course.ratingAvg,
    reviewsCount: course.ratingCount,
    enrolledCount: course._count?.enrollments ?? 0,
    createdBy,
    updatedAt: course.updatedAt,
    outcomes: (course.outcomes ?? []).map((o) => ({
      id: o.id,
      title: o.title,
      description: o.description ?? null,
    })),
    relatedTopics: course.relatedTopics ?? [],
    requirements: course.requirements ?? [],
    sections,
  };
}

/**
 * Single lecture + its DAM video stream metadata (fail-soft). 404 if missing.
 */
export async function getLecture({ tenantId, id } = {}) {
  const lectureId = Number(id);
  const lecture = await prisma.courseLecture.findFirst({
    where: scopedWhere(tenantId, { id: lectureId }),
  });

  if (!lecture) {
    throw Object.assign(new Error("Lecture not found"), { status: 404 });
  }

  const videoMediaId = lecture.videoMediaId ?? null;
  let video = null;
  if (videoMediaId != null) {
    try {
      video = await getDamAssetById(videoMediaId);
    } catch {
      video = null;
    }
  }

  return {
    id: lecture.id,
    sectionId: lecture.sectionId,
    title: lecture.title,
    durationSeconds: lecture.durationSeconds,
    durationMinutes: roundMinutes(lecture.durationSeconds),
    isPreview: lecture.isPreview,
    videoMediaId,
    streamPath: videoMediaId != null ? `/assets/video-stream/${videoMediaId}` : null,
    video,
  };
}

/**
 * Idempotent enrollment. Returns the existing enrollment if the employee is
 * already enrolled in the course; otherwise creates one (status ENROLLED).
 */
export async function enrollInCourse({ tenantId, courseId, employeeId } = {}) {
  const cId = Number(courseId);
  const eId = Number(employeeId);

  const existing = await prisma.trainingEnrollment.findFirst({
    where: scopedWhere(tenantId, { courseId: cId, employeeId: eId }),
  });

  const enrollment =
    existing ??
    (await prisma.trainingEnrollment.create({
      data: {
        courseId: cId,
        employeeId: eId,
        status: "ENROLLED",
        enrollmentDate: new Date(),
      },
    }));

  return {
    id: enrollment.id,
    courseId: enrollment.courseId,
    employeeId: enrollment.employeeId,
    status: enrollment.status,
    enrollmentDate: enrollment.enrollmentDate,
  };
}

/**
 * Create a review and recompute the course's denormalized rating rollup in ONE
 * tenant transaction (multi-statement flow → tenantTransaction required).
 */
export async function createReview({ tenantId, courseId, employeeId, rating, comment } = {}) {
  const cId = Number(courseId);
  const eId = employeeId != null ? Number(employeeId) : null;
  const stars = Number(rating);

  return tenantTransaction(
    prisma,
    async (tx) => {
      const review = await tx.courseReview.create({
        data: {
          courseId: cId,
          employeeId: eId,
          rating: stars,
          comment: comment ?? null,
        },
      });

      const agg = await tx.courseReview.aggregate({
        where: scopedWhere(tenantId, { courseId: cId }),
        _avg: { rating: true },
        _count: { _all: true },
      });

      const ratingAvg = round2(agg._avg.rating ?? 0);
      const ratingCount = agg._count._all ?? 0;

      await tx.trainingCourse.update({
        where: { id: cId },
        data: { ratingAvg, ratingCount },
      });

      return { review, ratingAvg, ratingCount };
    },
    { tenantId }
  );
}

// ── Section authoring ──────────────────────────────────────────────────────

export async function createSection({ tenantId, courseId, title, sortOrder } = {}) {
  return prisma.courseSection.create({
    data: {
      courseId: Number(courseId),
      title,
      sortOrder: sortOrder != null ? Number(sortOrder) : 0,
    },
  });
}

export async function updateSection({ tenantId, id, title, sortOrder } = {}) {
  const sectionId = Number(id);
  // Guard tenant scope: ensure the row belongs to the caller before update.
  const existing = await prisma.courseSection.findFirst({
    where: scopedWhere(tenantId, { id: sectionId }),
  });
  if (!existing) throw Object.assign(new Error("Section not found"), { status: 404 });

  const data = {};
  if (title !== undefined) data.title = title;
  if (sortOrder !== undefined) data.sortOrder = Number(sortOrder);

  return prisma.courseSection.update({ where: { id: sectionId }, data });
}

export async function deleteSection({ tenantId, id } = {}) {
  const sectionId = Number(id);
  const existing = await prisma.courseSection.findFirst({
    where: scopedWhere(tenantId, { id: sectionId }),
  });
  if (!existing) throw Object.assign(new Error("Section not found"), { status: 404 });

  await prisma.courseSection.delete({ where: { id: sectionId } });
  return { success: true, id: sectionId };
}

// ── Lecture authoring ──────────────────────────────────────────────────────

export async function createLecture({
  tenantId,
  sectionId,
  title,
  videoMediaId,
  durationSeconds,
  sortOrder,
  isPreview,
} = {}) {
  return prisma.courseLecture.create({
    data: {
      sectionId: Number(sectionId),
      title,
      videoMediaId: videoMediaId != null ? Number(videoMediaId) : null,
      durationSeconds: durationSeconds != null ? Number(durationSeconds) : 0,
      sortOrder: sortOrder != null ? Number(sortOrder) : 0,
      isPreview: isPreview != null ? Boolean(isPreview) : false,
    },
  });
}

export async function updateLecture({
  tenantId,
  id,
  title,
  videoMediaId,
  durationSeconds,
  sortOrder,
  isPreview,
} = {}) {
  const lectureId = Number(id);
  const existing = await prisma.courseLecture.findFirst({
    where: scopedWhere(tenantId, { id: lectureId }),
  });
  if (!existing) throw Object.assign(new Error("Lecture not found"), { status: 404 });

  const data = {};
  if (title !== undefined) data.title = title;
  if (videoMediaId !== undefined) data.videoMediaId = videoMediaId != null ? Number(videoMediaId) : null;
  if (durationSeconds !== undefined) data.durationSeconds = Number(durationSeconds);
  if (sortOrder !== undefined) data.sortOrder = Number(sortOrder);
  if (isPreview !== undefined) data.isPreview = Boolean(isPreview);

  return prisma.courseLecture.update({ where: { id: lectureId }, data });
}

export async function deleteLecture({ tenantId, id } = {}) {
  const lectureId = Number(id);
  const existing = await prisma.courseLecture.findFirst({
    where: scopedWhere(tenantId, { id: lectureId }),
  });
  if (!existing) throw Object.assign(new Error("Lecture not found"), { status: 404 });

  await prisma.courseLecture.delete({ where: { id: lectureId } });
  return { success: true, id: lectureId };
}

// ── Outcome authoring ──────────────────────────────────────────────────────

export async function createOutcome({ tenantId, courseId, title, description, sortOrder } = {}) {
  return prisma.courseOutcome.create({
    data: {
      courseId: Number(courseId),
      title,
      description: description ?? null,
      sortOrder: sortOrder != null ? Number(sortOrder) : 0,
    },
  });
}

export async function deleteOutcome({ tenantId, id } = {}) {
  const outcomeId = Number(id);
  const existing = await prisma.courseOutcome.findFirst({
    where: scopedWhere(tenantId, { id: outcomeId }),
  });
  if (!existing) throw Object.assign(new Error("Outcome not found"), { status: 404 });

  await prisma.courseOutcome.delete({ where: { id: outcomeId } });
  return { success: true, id: outcomeId };
}

// ── Course LMS-field patch ─────────────────────────────────────────────────

const CATALOG_PATCH_FIELDS = [
  "subtitle",
  "courseCode",
  "language",
  "tags",
  "relatedTopics",
  "requirements",
  "introVideoMediaId",
  "createdById",
  "mode",
  "description",
  "title",
  "categoryId",
  "status",
];

const CATALOG_INT_FIELDS = new Set(["introVideoMediaId", "createdById", "categoryId"]);

/**
 * Patch any subset of the course's LMS fields. Only keys explicitly provided
 * (!== undefined) are applied. Int fields are coerced.
 */
export async function updateCourseCatalogFields({ tenantId, id, ...fields } = {}) {
  const courseId = Number(id);
  const existing = await prisma.trainingCourse.findFirst({
    where: scopedWhere(tenantId, { id: courseId }),
  });
  if (!existing) throw Object.assign(new Error("Course not found"), { status: 404 });

  const data = {};
  for (const key of CATALOG_PATCH_FIELDS) {
    if (fields[key] === undefined) continue;
    if (CATALOG_INT_FIELDS.has(key)) {
      data[key] = fields[key] != null ? Number(fields[key]) : null;
    } else {
      data[key] = fields[key];
    }
  }

  return prisma.trainingCourse.update({ where: { id: courseId }, data });
}
