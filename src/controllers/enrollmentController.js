// src/controllers/enrollmentController.js
import * as enrollmentService from '../services/enrollmentService.js';

export const enrollUser = async (req, res) => {
    try {
        const enrollment = await enrollmentService.enrollUser(req.body);
        return res.status(201).json({
            success: true,
            message: 'User enrolled successfully',
            data: enrollment
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

export const bulkEnrollUsers = async (req, res) => {
    try {
        const { courseId, employeeIds } = req.body;
        const enrollments = await enrollmentService.bulkEnrollUsers(courseId, employeeIds);
        return res.status(201).json({
            success: true,
            message: 'Users enrolled successfully',
            data: enrollments
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

export const getUserEnrollments = async (req, res) => {
    try {
        const result = await enrollmentService.getUserEnrollments(req.params.employeeId, req.query);
        return res.status(200).json({
            success: true,
            message: 'Enrollments fetched successfully',
            data: result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

export const getCourseEnrollments = async (req, res) => {
    try {
        const result = await enrollmentService.getCourseEnrollments(req.params.courseId, req.query);
        return res.status(200).json({
            success: true,
            message: 'Course enrollments fetched successfully',
            data: result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

export const updateEnrollmentStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const enrollment = await enrollmentService.updateEnrollmentStatus(req.params.id, status);
        return res.status(200).json({
            success: true,
            message: 'Enrollment status updated successfully',
            data: enrollment
        });
    } catch (error) {
        if (error.message === 'Enrollment not found') {
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

export const updateProgress = async (req, res) => {
    try {
        const { progress } = req.body;
        const enrollment = await enrollmentService.updateProgress(req.params.id, progress);
        return res.status(200).json({
            success: true,
            message: 'Progress updated successfully',
            data: enrollment
        });
    } catch (error) {
        if (error.message === 'Enrollment not found') {
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

export const cancelEnrollment = async (req, res) => {
    try {
        const enrollment = await enrollmentService.cancelEnrollment(req.params.id);
        return res.status(200).json({
            success: true,
            message: 'Enrollment cancelled successfully',
            data: enrollment
        });
    } catch (error) {
        if (error.message === 'Enrollment not found') {
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

export const getEmployeeTranscript = async (req, res) => {
    try {
        const transcript = await enrollmentService.getEmployeeTranscript(req.params.employeeId);
        return res.status(200).json({
            success: true,
            message: 'Transcript fetched successfully',
            data: transcript
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

export const getComplianceStatus = async (req, res) => {
    try {
        const compliance = await enrollmentService.getComplianceStatus(req.params.employeeId);
        return res.status(200).json({
            success: true,
            message: 'Compliance status fetched successfully',
            data: compliance
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};