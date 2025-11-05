import * as holidayService from '../services/holiday.service.js';

export const getRegions = async (req, res) => {
  try {
    const regions = await holidayService.getRegions(req.query);
    res.json({ success: true, data: regions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getRegionById = async (req, res) => {
  try {
    const region = await holidayService.getRegionById(parseInt(req.params.id));
    if (!region) {
      return res.status(404).json({ success: false, error: 'Region not found' });
    }
    res.json({ success: true, data: region });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const createRegion = async (req, res) => {
  try {
    const region = await holidayService.createRegion({
      ...req.body,
      createdById: req.user.id
    });
    res.status(201).json({ success: true, data: region });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const updateRegion = async (req, res) => {
  try {
    const region = await holidayService.updateRegion(parseInt(req.params.id), req.body);
    res.json({ success: true, data: region });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const deleteRegion = async (req, res) => {
  try {
    await holidayService.deleteRegion(parseInt(req.params.id));
    res.json({ success: true, message: 'Region deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const getHolidayCalendars = async (req, res) => {
  try {
    const calendars = await holidayService.getHolidayCalendars(req.query);
    res.json({ success: true, data: calendars });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getHolidayCalendarById = async (req, res) => {
  try {
    const calendar = await holidayService.getHolidayCalendarById(parseInt(req.params.id));
    if (!calendar) {
      return res.status(404).json({ success: false, error: 'Holiday calendar not found' });
    }
    res.json({ success: true, data: calendar });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const createHolidayCalendar = async (req, res) => {
  try {
    const calendar = await holidayService.createHolidayCalendar({
      ...req.body,
      createdById: req.user.id
    });
    res.status(201).json({ success: true, data: calendar });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const updateHolidayCalendar = async (req, res) => {
  try {
    const calendar = await holidayService.updateHolidayCalendar(parseInt(req.params.id), req.body);
    res.json({ success: true, data: calendar });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const deleteHolidayCalendar = async (req, res) => {
  try {
    await holidayService.deleteHolidayCalendar(parseInt(req.params.id));
    res.json({ success: true, message: 'Holiday calendar deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const getHolidays = async (req, res) => {
  try {
    const holidays = await holidayService.getHolidays(req.query);
    res.json({ success: true, data: holidays });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getHolidaysByCalendar = async (req, res) => {
  try {
    const holidays = await holidayService.getHolidaysByCalendar(parseInt(req.params.calendarId), req.query);
    res.json({ success: true, data: holidays });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const createHoliday = async (req, res) => {
  try {
    const holiday = await holidayService.createHoliday({
      ...req.body,
      createdById: req.user.id
    });
    res.status(201).json({ success: true, data: holiday });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const updateHoliday = async (req, res) => {
  try {
    const holiday = await holidayService.updateHoliday(
      parseInt(req.params.calendarId),
      req.params.date,
      req.body
    );
    res.json({ success: true, data: holiday });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const deleteHoliday = async (req, res) => {
  try {
    await holidayService.deleteHoliday(parseInt(req.params.calendarId), req.params.date);
    res.json({ success: true, message: 'Holiday deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const getEmployeeHolidays = async (req, res) => {
  try {
    const holidays = await holidayService.getEmployeeHolidays(parseInt(req.params.employeeId), req.query);
    res.json({ success: true, data: holidays });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Additional endpoints
export const getUpcomingHolidays = async (req, res) => {
  try {
    const { days = 30, regionId } = req.query;
    const holidays = await holidayService.getUpcomingHolidays(days, regionId);
    res.json({ success: true, data: holidays });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const checkHoliday = async (req, res) => {
  try {
    const { date, regionId } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: 'Date parameter is required' });
    }

    const isHoliday = await holidayService.isHoliday(date, regionId);
    res.json({ success: true, data: { date, isHoliday } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const assignEmployeeCalendar = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { calendarId, effectiveFrom, effectiveTo } = req.body;

    const assignment = await holidayService.assignEmployeeToCalendar(
      parseInt(employeeId),
      parseInt(calendarId),
      effectiveFrom,
      effectiveTo
    );

    res.status(201).json({ success: true, data: assignment });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const getEmployeeCalendarAssignments = async (req, res) => {
  try {
    const assignments = await holidayService.getEmployeeCalendarAssignments(parseInt(req.params.employeeId));
    res.json({ success: true, data: assignments });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const importHolidaysBulk = async (req, res) => {
  try {
    const { calendarId } = req.params;
    const { holidays } = req.body;

    const result = await holidayService.importHolidays(parseInt(calendarId), holidays, req.user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};