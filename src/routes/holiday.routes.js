import express from 'express';
import * as holidayController from '../controllers/holiday.controller.js';

const router = express.Router();


// Regions
router.get('/regions', holidayController.getRegions);
router.get('/regions/:id', holidayController.getRegionById);
router.post('/regions', holidayController.createRegion);
router.put('/regions/:id', holidayController.updateRegion);
router.delete('/regions/:id', holidayController.deleteRegion);

// Holiday Calendars
router.get('/calendars', holidayController.getHolidayCalendars);
router.get('/calendars/:id', holidayController.getHolidayCalendarById);
router.post('/calendars', holidayController.createHolidayCalendar);
router.put('/calendars/:id', holidayController.updateHolidayCalendar);
router.delete('/calendars/:id', holidayController.deleteHolidayCalendar);

// Holidays
router.get('/holidays', holidayController.getHolidays);
router.get('/holidays/calendar/:calendarId', holidayController.getHolidaysByCalendar);
router.post('/holidays', holidayController.createHoliday);
router.put('/holidays/:calendarId/:date', holidayController.updateHoliday);
router.delete('/holidays/:calendarId/:date', holidayController.deleteHoliday);

// Employee-specific holiday views
router.get('/employee/:employeeId/holidays', holidayController.getEmployeeHolidays);
router.get('/employee/:employeeId/calendar-assignments', holidayController.getEmployeeCalendarAssignments);
router.post('/employee/:employeeId/assign-calendar', holidayController.assignEmployeeCalendar);

// Additional endpoints
router.get('/upcoming', holidayController.getUpcomingHolidays);
router.get('/check', holidayController.checkHoliday);
router.post('/calendars/:calendarId/import', holidayController.importHolidaysBulk);

export default router;