import asyncHandler from 'express-async-handler';
import * as overtimeService from '../services/overtimeService.js';

// @desc    Get overtime rules
// @route   GET /api/time-attendance/overtime-rules
// @access  Private
const getOvertimeRules = asyncHandler(async (req, res) => {
    const rules = await overtimeService.getOvertimeRules();

    res.json({
        success: true,
        data: rules
    });
});

// @desc    Create overtime rule
// @route   POST /api/time-attendance/overtime-rules
// @access  Private
const createOvertimeRule = asyncHandler(async (req, res) => {
    const rule = await overtimeService.createOvertimeRule(req.body);

    res.status(201).json({
        success: true,
        data: rule
    });
});

// @desc    Update overtime rule
// @route   PUT /api/time-attendance/overtime-rules/:id
// @access  Private
const updateOvertimeRule = asyncHandler(async (req, res) => {
    const rule = await overtimeService.updateOvertimeRule(req.params.id, req.body);

    res.json({
        success: true,
        data: rule
    });
});

// @desc    Delete overtime rule
// @route   DELETE /api/time-attendance/overtime-rules/:id
// @access  Private
const deleteOvertimeRule = asyncHandler(async (req, res) => {
    await overtimeService.deleteOvertimeRule(req.params.id);

    res.json({
        success: true,
        message: 'Overtime rule deleted successfully'
    });
});

// @desc    Calculate overtime for employee
// @route   GET /api/time-attendance/overtime/calculate
// @access  Private
const calculateOvertime = asyncHandler(async (req, res) => {
    const { employeeId, periodStart, periodEnd } = req.query;

    const overtime = await overtimeService.calculateOvertime({
        employeeId: employeeId || req.user.id,
        periodStart,
        periodEnd
    });

    res.json({
        success: true,
        data: overtime
    });
});

export {
    getOvertimeRules,
    createOvertimeRule,
    updateOvertimeRule,
    deleteOvertimeRule,
    calculateOvertime
};