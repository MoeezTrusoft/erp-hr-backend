// src/services/trainingService.js
import { PrismaClient } from "@prisma/client";


const prisma = new PrismaClient();
export const createCourse = async (courseData) => {
    try {
        if (!courseData.title || !courseData.categoryId) {
            throw new Error('Title and categoryId are required');
        }

        const course = await prisma.trainingCourse.create({
            data: {
                title: courseData.title,
                description: courseData.description,
                categoryId: parseInt(courseData.categoryId),
                instructorId: courseData.instructorId ? parseInt(courseData.instructorId) : null,
                durationHours: courseData.durationHours ? parseInt(courseData.durationHours) : null,
                location: courseData.location,
                mode: courseData.mode || 'ONLINE',
                startDate: courseData.startDate,
                endDate: courseData.endDate,
                status: courseData.status || 'DRAFT'
            },
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
        });

        return course;
    } catch (error) {
        throw new Error(`Failed to create course: ${error.message}`);
    }
};

export const getCourses = async (filters = {}) => {
    try {
        const {
            categoryId,
            status,
            mode,
            instructorId,
            page = 1,
            limit = 10
        } = filters;

        const skip = (page - 1) * limit;

        const where = {};
        if (categoryId) where.categoryId = parseInt(categoryId);
        if (status) where.status = status;
        if (mode) where.mode = mode;
        if (instructorId) where.instructorId = parseInt(instructorId);

        const [courses, total] = await Promise.all([
            prisma.trainingCourse.findMany({
                where,
                include: {
                    category: true,
                    instructor: {
                        select: {
                            id: true,
                            first_name: true,
                            last_name: true
                        }
                    },
                    enrollments: {
                        select: {
                            id: true,
                            status: true
                        }
                    }
                },
                skip,
                take: parseInt(limit),
                orderBy: { createdAt: 'desc' }
            }),
            prisma.trainingCourse.count({ where })
        ]);

        return {
            courses,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        };
    } catch (error) {
        throw new Error(`Failed to fetch courses: ${error.message}`);
    }
};

export const getCourseById = async (courseId) => {
    try {
        if (!courseId) {
            throw new Error('Course ID is required');
        }

        const course = await prisma.trainingCourse.findUnique({
            where: { id: parseInt(courseId) },
            include: {
                category: true,
                instructor: {
                    select: {
                        id: true,
                        first_name: true,
                        last_name: true
                    }
                },
                enrollments: {
                    include: {
                        employee: {
                            select: {
                                id: true,
                                first_name: true,
                                last_name: true
                            }
                        }
                    }
                }
            }
        });

        if (!course) {
            throw new Error('Course not found');
        }

        return course;
    } catch (error) {
        throw new Error(`Failed to fetch course: ${error.message}`);
    }
};

export const updateCourse = async (courseId, updateData) => {
    try {
        if (!courseId) {
            throw new Error('Course ID is required');
        }

        const course = await prisma.trainingCourse.update({
            where: { id: parseInt(courseId) },
            data: updateData,
            include: {
                category: true,
                instructor: true
            }
        });

        return course;
    } catch (error) {
        if (error.code === 'P2025') {
            throw new Error('Course not found');
        }
        throw new Error(`Failed to update course: ${error.message}`);
    }
};

export const deleteCourse = async (courseId) => {
    try {
        if (!courseId) {
            throw new Error('Course ID is required');
        }

        // Check if there are enrollments
        const enrollments = await prisma.trainingEnrollment.count({
            where: { courseId: parseInt(courseId) }
        });

        if (enrollments > 0) {
            throw new Error('Cannot delete course with existing enrollments');
        }

        await prisma.trainingCourse.delete({
            where: { id: parseInt(courseId) }
        });

        return { message: 'Course deleted successfully' };
    } catch (error) {
        if (error.code === 'P2025') {
            throw new Error('Course not found');
        }
        throw new Error(`Failed to delete course: ${error.message}`);
    }
};

export const createCategory = async (categoryData) => {
    try {
        if (!categoryData.name) {
            throw new Error('Category name is required');
        }

        const category = await prisma.trainingCategory.create({
            data: {
                name: categoryData.name,
                description: categoryData.description
            }
        });

        return category;
    } catch (error) {
        throw new Error(`Failed to create category: ${error.message}`);
    }
};

export const getCategories = async () => {
    try {
        const categories = await prisma.trainingCategory.findMany({
            include: {
                courses: {
                    select: {
                        id: true,
                        title: true,
                        status: true
                    }
                }
            },
            orderBy: { name: 'asc' }
        });

        return categories;
    } catch (error) {
        throw new Error(`Failed to fetch categories: ${error.message}`);
    }
};