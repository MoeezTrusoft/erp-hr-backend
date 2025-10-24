import * as enrollmentService from "../services/trainingEnrollment.service.js";

export const enrollEmployee = async (req, res) => {
  try {
    const result = await enrollmentService.enrollEmployee(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getAllEnrollments = async (req, res) => {
  try {
    const result = await enrollmentService.getEnrollments();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getEnrollmentById = async (req, res) => {
  try {
    const result = await enrollmentService.getEnrollmentById(req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(404).json({ success: false, message: error.message });
  }
};

export const updateEnrollment = async (req, res) => {
  try {
    const result = await enrollmentService.updateEnrollment(req.params.id, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteEnrollment = async (req, res) => {
  try {
    await enrollmentService.deleteEnrollment(req.params.id);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateEnrollmentProgress = async (req, res) => {
  try {
    const { progress } = req.body;
    const id = req.params.id;
    const result = await enrollmentService.updateEnrollmentProgress(id, { progress });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    // validation errors -> 400, not found or prisma errors -> 400/404 as appropriate
    res.status(400).json({ success: false, message: error.message });
  }
};