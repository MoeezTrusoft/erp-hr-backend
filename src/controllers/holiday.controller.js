import * as holidayService from "../services/holiday.service.js";

export const createHoliday = async (req, res) => {
  try {
    const holiday = await holidayService.createHoliday(req.body);
    res.status(201).json({ success: true, holiday });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getAllHolidays = async (req, res) => {
  try {
    const holidays = await holidayService.getAllHolidays();
    res.json({ success: true, holidays });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getHolidayById = async (req, res) => {
  try {
    const holiday = await holidayService.getHolidayById(req.params.id);
    res.json({ success: true, holiday });
  } catch (error) {
    res.status(404).json({ success: false, message: error.message });
  }
};

export const updateHoliday = async (req, res) => {
  try {
    const holiday = await holidayService.updateHoliday(req.params.id, req.body);
    res.json({ success: true, holiday });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteHoliday = async (req, res) => {
  try {
    const result = await holidayService.deleteHoliday(req.params.id);
    res.json({ success: true, message: result.message });
  } catch (error) {
    res.status(404).json({ success: false, message: error.message });
  }
};
