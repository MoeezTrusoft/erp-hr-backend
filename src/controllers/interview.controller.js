import * as svc from "../services/interview.service.js";

export const scheduleInterview = async (req, res) => {
    try {
        const result = await svc.scheduleInterview(req.body);
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const listInterviews = async (req, res) => {
    try {
        const { applicationId, page, limit } = req.query;
        const result = await svc.listInterviews({ applicationId, page: Number(page) || 1, limit: Number(limit) || 20 });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

export const updateInterview = async (req, res) => {
    try {
        const reviewerId = req.headers["x-employee-id"] || req.user?.employeeId;
        const result = await svc.updateInterview(req.params.id, {
            ...req.body,
            reviewerId,
        });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const submitScorecard = async (req, res) => {
    try {
        const reviewerId = req.headers["x-employee-id"];
        const result = await svc.submitScorecard({ ...req.body, interviewId: req.params.id, reviewerId });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const getScorecards = async (req, res) => {
    try {
        const result = await svc.getScorecards(req.params.id);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
