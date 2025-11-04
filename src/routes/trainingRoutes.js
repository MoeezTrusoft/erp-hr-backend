// src/routes/trainingRoutes.js
import express from 'express';
import {
    createCourse,
    getCourses,
    getCourse,
    updateCourse,
    deleteCourse,
    createCategory,
    getCategories
} from '../controllers/trainingController.js';

import {
    enrollUser,
    bulkEnrollUsers,
    getUserEnrollments,
    getCourseEnrollments,
    updateEnrollmentStatus,
    updateProgress,
    cancelEnrollment,
    getEmployeeTranscript,
    getComplianceStatus
} from '../controllers/enrollmentController.js';

const router = express.Router();

// Course routes
router.post('/courses', createCourse);
router.get('/courses', getCourses);
router.get('/courses/:id', getCourse);
router.put('/courses/:id', updateCourse);
router.delete('/courses/:id', deleteCourse);

// Category routes
router.post('/categories', createCategory);
router.get('/categories', getCategories);

// Enrollment routes
router.post('/enrollments', enrollUser);
router.post('/enrollments/bulk', bulkEnrollUsers);
router.get('/employees/:employeeId/enrollments', getUserEnrollments);
router.get('/courses/:courseId/enrollments', getCourseEnrollments);
router.put('/enrollments/:id/status', updateEnrollmentStatus);
router.put('/enrollments/:id/progress', updateProgress);
router.delete('/enrollments/:id', cancelEnrollment);

// Transcript and Compliance routes
router.get('/employees/:employeeId/transcript', getEmployeeTranscript);
router.get('/employees/:employeeId/compliance', getComplianceStatus);

export default router;