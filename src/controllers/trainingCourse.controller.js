import * as courseService from "../services/trainingCourse.service.js";

export const createCourse = async (req, res) => {
  try {
    const result = await courseService.createCourse(req.body);
    res.status(201).json({ success: true, message: "Success", data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getAllCourses = async (req, res) => {
  try {
    const result = await courseService.getAllCourses();
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getCourseById = async (req, res) => {
  try {
    const result = await courseService.getCourseById(req.params.id);
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (error) {
    res.status(404).json({ success: false, message: error.message });
  }
};

export const updateCourse = async (req, res) => {
  try {
    const result = await courseService.updateCourse(req.params.id, req.body);
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteCourse = async (req, res) => {
  try {
    await courseService.deleteCourse(req.params.id);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const uploadCourseMaterial = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }
    const result = await courseService.uploadCourseMaterial(req.params.id, req.files[0]);
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getUpcomingCourses = async (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : 30;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;

    const result = await courseService.getUpcomingCourses({ days, limit, offset });
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getCourseAnalytics = async (req, res) => {
  try {
    const result = await courseService.getCourseAnalytics(req.params.id);
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getGlobalAnalyticsOverview = async (req, res) => {
  try {
    const result = await courseService.getGlobalAnalyticsOverview();
    res.status(200).json({ success: true, message: "Success", data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
