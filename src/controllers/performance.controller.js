import * as performanceService from "../services/performance.service.js";

export const createPerformanceReview = async (req, res) => {
  try {
     const createdBy = req.headers['employee-id'];
    const review = await performanceService.createPerformanceReview(req.body,createdBy);
    res.status(201).json({ success: true, review });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getAllReviews = async (req, res) => {
  try {
    const reviews = await performanceService.getAllReviews();
    res.json({ success: true, reviews });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getReviewsByEmployee = async (req, res) => {
  try {
    const reviews = await performanceService.getReviewsByEmployee(req.params.employeeId);
    res.json({ success: true, reviews });
  } catch (error) {
    res.status(404).json({ success: false, message: error.message });
  }
};

export const updateReview = async (req, res) => {
  try {
     const updatedBy = req.headers['employee-id'];
    const review = await performanceService.updateReview(req.params.id, req.body,updatedBy);
    res.json({ success: true, review });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};



export const addFeedback = async (req, res) => {
  try {
     const createdBy = req.headers['employee-id'];
    const feedback = await performanceService.addFeedback(req.body,createdBy);
    res.status(201).json({ success: true, feedback });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const updateFeedback = async (req, res) => {
  try {
     const updatedBy = req.headers['employee-id'];
    const feedback = await performanceService.updateFeedback(req.params.id,req.body,updatedBy );
    res.status(201).json({ success: true, feedback });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};


export const deleteFeedback = async (req, res) => {
  try {
             const deletedBy = req.headers['employee-id'];

    const result = await performanceService.deleteFeedback(req.params.id,deletedBy);
    res.json({ success: true, message: result.message });
  } catch (error) {
    res.status(404).json({ success: false, message: error.message });
  }
};
