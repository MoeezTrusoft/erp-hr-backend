// src/controllers/trainingController.js
import * as trainingService from '../services/trainingService.js';

export const createCourse = async (req, res) => {
    try {
        const course = await trainingService.createCourse(req.body);
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
        const result = await trainingService.getCourses(req.query);
        return res.status(200).json({
            success: true,
            message: 'Courses fetched successfully',
            data: result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

export const getCourse = async (req, res) => {
    try {
        const course = await trainingService.getCourseById(req.params.id);
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
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

export const updateCourse = async (req, res) => {
    try {
        const course = await trainingService.updateCourse(req.params.id, req.body);
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
        const result = await trainingService.deleteCourse(req.params.id);
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
        const category = await trainingService.createCategory(req.body);
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
        const categories = await trainingService.getCategories();
        return res.status(200).json({
            success: true,
            message: 'Categories fetched successfully',
            data: categories
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};