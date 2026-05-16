import * as svc from "../services/learningPath.service.js";

export const createPath = async (req, res) => {
    try {
        const createdById = req.headers["x-employee-id"];
        const result = await svc.createPath({ ...req.body, createdById });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const listPaths = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await svc.listPaths({ page: Number(page) || 1, limit: Number(limit) || 20 });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

export const getPath = async (req, res) => {
    try {
        const result = await svc.getPath(req.params.id);
        if (!result) return res.status(404).json({ success: false, message: "Not found" });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const updatePath = async (req, res) => {
    try {
        const result = await svc.updatePath(req.params.id, req.body);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const addCourseToPath = async (req, res) => {
    try {
        const result = await svc.addCourseToPath({ ...req.body, pathId: req.params.id });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const enrollEmployee = async (req, res) => {
    try {
        const result = await svc.enrollEmployee({ pathId: req.params.id, employeeId: req.body.employeeId });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
