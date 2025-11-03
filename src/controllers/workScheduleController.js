import asyncHandler from 'express-async-handler';
import { workScheduleService } from '../services/workScheduleService.js';

// @desc    Get work schedules
// @route   GET /api/time-attendance/work-schedules
// @access  Private
const getWorkSchedules = asyncHandler(async (req, res) => {
    const { employeeId } = req.query;

    const schedules = await workScheduleService.getWorkSchedules({
        employeeId: employeeId || req.user.id
    });

    res.json({
        success: true,
        data: schedules
    });
});

// @desc    Create work schedule
// @route   POST /api/time-attendance/work-schedules
// @access  Private
const createWorkSchedule = asyncHandler(async (req, res) => {
    const scheduleData = {
        ...req.body,
        employeeId: req.body.employeeId || req.user.id
    };

    const schedule = await workScheduleService.createWorkSchedule(scheduleData);

    res.status(201).json({
        success: true,
        data: schedule
    });
});

// @desc    Update work schedule
// @route   PUT /api/time-attendance/work-schedules/:id
// @access  Private
const updateWorkSchedule = asyncHandler(async (req, res) => {
    const schedule = await workScheduleService.updateWorkSchedule(req.params.id, req.body);

    res.json({
        success: true,
        data: schedule
    });
});

// @desc    Delete work schedule
// @route   DELETE /api/time-attendance/work-schedules/:id
// @access  Private
const deleteWorkSchedule = asyncHandler(async (req, res) => {
    await workScheduleService.deleteWorkSchedule(req.params.id);

    res.json({
        success: true,
        message: 'Work schedule deleted successfully'
    });
});

export {
    getWorkSchedules,
    createWorkSchedule,
    updateWorkSchedule,
    deleteWorkSchedule
};