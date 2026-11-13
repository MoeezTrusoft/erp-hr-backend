// src/controllers/trainingController.js
import * as trainingService from '../services/trainingService.js';
import { respondServerError } from '../utils/httpError.js';

// C.2-completion — the verified tenant arrives ONLY on req.user.tenantId (set by
// internalServiceGuard from the signed service-JWT claim; T-P2.1), NEVER from a
// header. Threaded into the scoped training service calls so tenant B cannot
// read/mutate tenant A's courses/categories.
const tenantOf = (req) => req.user?.tenantId;

export const createCourse = async (req, res) => {
    try {
        const createdBy = req.headers?.['employee-id'];
        const course = await trainingService.createCourse({ ...req.body, tenantId: tenantOf(req) }, createdBy);
        return res.status(201).json({
            success: true,
            message: 'Course created successfully',
            data: course
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

export const getCourses = async (req, res) => {
    try {
        const result = await trainingService.getCourses({ ...req.query, tenantId: tenantOf(req) });
        return res.status(200).json({
            success: true,
            message: 'Courses fetched successfully',
            data: result
        });
    } catch (error) {
        return respondServerError(req, res, error);
    }
};

export const getCourse = async (req, res) => {
    try {
        const course = await trainingService.getCourseById(req.params.id, tenantOf(req));
        return res.status(200).json({
            success: true,
            message: 'Course fetched successfully',
            data: course
        });
    } catch (error) {
        if (error.message === 'Course not found') {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }
        return respondServerError(req, res, error);
    }
};

export const updateCourse = async (req, res) => {
    try {
        const updatedBy = req.headers?.['employee-id'];
        const course = await trainingService.updateCourse(req.params.id, req.body, updatedBy, tenantOf(req));
        return res.status(200).json({
            success: true,
            message: 'Course updated successfully',
            data: course
        });
    } catch (error) {
        if (error.message === 'Course not found') {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

export const deleteCourse = async (req, res) => {
    try {
        const deletedBy = req.headers?.['employee-id'];
        const result = await trainingService.deleteCourse(req.params.id, deletedBy, tenantOf(req));
        return res.status(200).json({
            success: true,
            message: result.message
        });
    } catch (error) {
        if (error.message === 'Course not found') {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

export const createCategory = async (req, res) => {
    try {

        const createdBy = req.headers?.['employee-id'];
        const category = await trainingService.createCategory({ ...req.body, tenantId: tenantOf(req) }, createdBy);
        return res.status(201).json({
            success: true,
            message: 'Category created successfully',
            data: category
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

export const getCategories = async (req, res) => {
    try {
        const categories = await trainingService.getCategories(tenantOf(req));
        return res.status(200).json({
            success: true,
            message: 'Categories fetched successfully',
            data: categories
        });
    } catch (error) {
        return respondServerError(req, res, error);
    }
};