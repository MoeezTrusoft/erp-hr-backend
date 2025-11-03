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
    const region = await holidayService.createRegion(req.body);
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
    const calendar = await holidayService.createHolidayCalendar(req.body);
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
    const holiday = await holidayService.createHoliday(req.body);
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