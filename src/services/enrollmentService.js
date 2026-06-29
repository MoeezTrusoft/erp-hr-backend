// src/services/enrollmentService.js
import prisma from "../lib/prisma.js";
import { logAction } from "../utils/logs.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";

// C.2-completion — verified tenant (T-P2.1) threaded via `tenantId` (inside the
// enrollment payload, or a trailing read/update param); folded into enrollment
// reads/writes fail-closed so tenant B never touches tenant A's enrollments.

export const enrollUser = async (enrollmentData, createdBy) => {
    try {
        if (!enrollmentData.courseId || !enrollmentData.employeeId) {
            throw new Error('Course ID and Employee ID are required');
        }

        const { tenantId } = enrollmentData;

        // Check if user is already enrolled (scoped to this tenant)
        const existingEnrollment = await prisma.trainingEnrollment.findFirst({
            where: scopedWhere(tenantId, {
                courseId: parseInt(enrollmentData.courseId),
                employeeId: parseInt(enrollmentData.employeeId),
                status: {
                    in: ['ENROLLED', 'IN_PROGRESS']
                }
            })
        });

        if (existingEnrollment) {
            throw new Error('User is already enrolled in this course');
        }

        const enrollment = await prisma.trainingEnrollment.create({
            data: scopedData(tenantId, {
                courseId: parseInt(enrollmentData.courseId),
                employeeId: parseInt(enrollmentData.employeeId),
                status: 'ENROLLED'
            }),
            include: {
                course: {
                    include: {
                        category: true
                    }
                },
                employee: {
                    select: {
                        id: true,
                        first_name: true,
                        last_name: true
                    }
                }
            }
        });

   await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Training Enrollment",
    result: "SUCCESS",
    notes: `Training Enrollment "${enrollment.id}" Created successfully`,
  });

        return enrollment;
    } catch (error) {
        throw new Error(`Failed to enroll user: ${error.message}`);
    }
};

export const bulkEnrollUsers = async (courseId, employeeIds, createdBy, tenantId) => {
    try {
        if (!courseId || !employeeIds || !Array.isArray(employeeIds)) {
            throw new Error('Course ID and Employee IDs array are required');
        }

        const enrollments = await prisma.$transaction(
            employeeIds.map(employeeId =>
                prisma.trainingEnrollment.create({
                    data: scopedData(tenantId, {
                        courseId: parseInt(courseId),
                        employeeId: parseInt(employeeId),
                        status: 'ENROLLED'
                    }),
                    include: {
                        employee: {
                            select: {
                                id: true,
                                first_name: true,
                                last_name: true
                            }
                        }
                    }
                })
            )
        );

 await logAction({
    employeeId: Number(createdBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Training Enrollment",
    result: "SUCCESS",
    notes: `Training Enrollment "${enrollments.id}" Created successfully`,
  });


        return enrollments;
    } catch (error) {
        throw new Error(`Failed to bulk enroll users: ${error.message}`);
    }
};

export const getUserEnrollments = async (employeeId, filters = {}) => {
    try {

        if (!employeeId) {
            throw new Error('Employee ID is required');
        }

        const { status, page = 1, limit = 10 } = filters;
        const skip = (page - 1) * limit;

        const where = scopedWhere(filters.tenantId, { employeeId: parseInt(employeeId) });
        if (status) where.status = status;

        const [enrollments, total] = await Promise.all([
            prisma.trainingEnrollment.findMany({
                where,
                include: {
                    course: {
                        include: {
                            category: true,
                            instructor: {
                                select: {
                                    id: true,
                                    first_name: true,
                                    last_name: true
                                }
                            }
                        }
                    }
                },
                skip,
                take: parseInt(limit),
                orderBy: { enrollmentDate: 'desc' }
            }),
            prisma.trainingEnrollment.count({ where })
        ]);

        return {
            enrollments,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        };
    } catch (error) {
        throw new Error(`Failed to fetch user enrollments: ${error.message}`);
    }
};

export const getCourseEnrollments = async (courseId, filters = {}) => {
    try {
        if (!courseId) {
            throw new Error('Course ID is required');
        }

        const { status, page = 1, limit = 10 } = filters;
        const skip = (page - 1) * limit;

        const where = scopedWhere(filters.tenantId, { courseId: parseInt(courseId) });
        if (status) where.status = status;

        const [enrollments, total] = await Promise.all([
            prisma.trainingEnrollment.findMany({
                where,
                include: {
                    employee: {
                        select: {
                            id: true,
                            first_name: true,
                            last_name: true,
                            job_title: true
                        }
                    }
                },
                skip,
                take: parseInt(limit),
                orderBy: { enrollmentDate: 'desc' }
            }),
            prisma.trainingEnrollment.count({ where })
        ]);

        return {
            enrollments,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        };
    } catch (error) {
        throw new Error(`Failed to fetch course enrollments: ${error.message}`);
    }
};

export const updateEnrollmentStatus = async (enrollmentId, status, updatedBy, tenantId) => {
    try {
        if (!enrollmentId || !status) {
            throw new Error('Enrollment ID and status are required');
        }

        // When a verified tenant is supplied, guard the row by tenant first so a
        // cross-tenant id can't be mutated. Legacy (no-tenant) callers keep the
        // original P2025-translation pathway untouched.
        if (tenantId !== undefined) {
            const existing = await prisma.trainingEnrollment.findFirst({ where: scopedWhere(tenantId, { id: parseInt(enrollmentId) }) });
            if (!existing) throw new Error('Enrollment not found');
        }

        const updateData = { status };
        if (status === 'COMPLETED') {
            updateData.completionDate = new Date();
            updateData.progress = 100;
        }

        const enrollment = await prisma.trainingEnrollment.update({
            where: { id: parseInt(enrollmentId) },
            data: updateData,
            include: {
                course: true,
                employee: {
                    select: {
                        id: true,
                        first_name: true,
                        last_name: true
                    }
                }
            }
        });

         await logAction({
    employeeId: Number(updatedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Training Enrollment",
    result: "SUCCESS",
    notes: `Training Enrollment "${enrollmentId}" Updated successfully`,
  });


        return enrollment;
    } catch (error) {
        if (error.code === 'P2025') {
            throw new Error('Enrollment not found');
        }
        throw new Error(`Failed to update enrollment status: ${error.message}`);
    }
};

export const updateProgress = async (enrollmentId, progress, updatedBy, tenantId) => {
    try {
        if (!enrollmentId || progress === undefined) {
            throw new Error('Enrollment ID and progress are required');
        }

        // When a verified tenant is supplied, guard the row by tenant first so a
        // cross-tenant id can't be mutated. Legacy (no-tenant) callers keep the
        // original P2025-translation pathway untouched.
        if (tenantId !== undefined) {
            const existing = await prisma.trainingEnrollment.findFirst({ where: scopedWhere(tenantId, { id: parseInt(enrollmentId) }) });
            if (!existing) throw new Error('Enrollment not found');
        }

        const enrollment = await prisma.trainingEnrollment.update({
            where: { id: parseInt(enrollmentId) },
            data: {
                progress: Math.min(parseFloat(progress), 100),
                status: parseFloat(progress) === 100 ? 'COMPLETED' : 'IN_PROGRESS'
            },
            include: {
                course: true,
                employee: {
                    select: {
                        id: true,
                        first_name: true,
                        last_name: true
                    }
                }
            }
        });

         await logAction({
    employeeId: Number(updatedBy),
    type: "Update", // 👈 changed from CREATE to UPDATE
    module: "Training Enrollment",
    result: "SUCCESS",
    notes: `Training Enrollment "${enrollmentId}" Updated successfully`,
  });

        return enrollment;
    } catch (error) {
        if (error.code === 'P2025') {
            throw new Error('Enrollment not found');
        }
        throw new Error(`Failed to update progress: ${error.message}`);
    }
};

export const getEmployeeTranscript = async (employeeId, tenantId) => {
    try {
        if (!employeeId) {
            throw new Error('Employee ID is required');
        }

        const enrollments = await prisma.trainingEnrollment.findMany({
            where: scopedWhere(tenantId, {
                employeeId: parseInt(employeeId),
                status: 'COMPLETED'
            }),
            include: {
                course: {
                    include: {
                        category: true,
                        instructor: {
                            select: {
                                id: true,
                                first_name: true,
                                last_name: true
                            }
                        }
                    }
                }
            },
            orderBy: { completionDate: 'desc' }
        });

        return enrollments;
    } catch (error) {
        throw new Error(`Failed to fetch transcript: ${error.message}`);
    }
};
export const cancelEnrollment = async (enrollmentId, cancelledBy) => {
    try {
        if (!enrollmentId) {
            throw new Error('Enrollment ID is required');
        }

        const enrollment = await prisma.trainingEnrollment.update({
            where: { id: parseInt(enrollmentId) },
            data: { status: 'CANCELLED' },
            include: {
                course: true,
                employee: {
                    select: {
                        id: true,
                        first_name: true,
                        last_name: true
                    }
                }
            }
        });
 await logAction({
    employeeId: Number(cancelledBy),
    type: "Create", // 👈 changed from CREATE to UPDATE
    module: "Training Enrollment",
    result: "SUCCESS",
    notes: `Training Enrollment "${enrollmentId}" Cancelled successfully`,
  });

        return enrollment;
    } catch (error) {
        if (error.code === 'P2025') {
            throw new Error('Enrollment not found');
        }
        throw new Error(`Failed to cancel enrollment: ${error.message}`);
    }
};

export const getComplianceStatus = async (employeeId) => {
    try {
        if (!employeeId) {
            throw new Error('Employee ID is required');
        }

        // Get all mandatory courses (you can define criteria for mandatory courses)
        const mandatoryCourses = await prisma.trainingCourse.findMany({
            where: {
                status: 'ACTIVE'
                // Add additional criteria for mandatory courses if needed
                // e.g., category: { name: 'Compliance' }
            }
        });

        const completedCourses = await prisma.trainingEnrollment.findMany({
            where: {
                employeeId: parseInt(employeeId),
                status: 'COMPLETED'
            },
            select: { courseId: true }
        });

        const completedCourseIds = new Set(completedCourses.map(c => c.courseId));

        const complianceStatus = mandatoryCourses.map(course => ({
            courseId: course.id,
            courseTitle: course.title,
            completed: completedCourseIds.has(course.id),
            dueDate: null // You can calculate based on company policy
        }));

        return {
            employeeId: parseInt(employeeId),
            totalMandatory: mandatoryCourses.length,
            completed: completedCourseIds.size,
            complianceRate: mandatoryCourses.length > 0 ?
                (completedCourseIds.size / mandatoryCourses.length) * 100 : 100,
            courses: complianceStatus
        };
    } catch (error) {
        throw new Error(`Failed to fetch compliance status: ${error.message}`);
    }
};