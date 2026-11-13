import * as svc from "../services/learningPath.service.js";
import { respondServerError } from '../utils/httpError.js';

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped learning-path service so tenant B cannot read/mutate tenant A's paths.
const tenantOf = (req) => req.user?.tenantId;

export const createPath = async (req, res) => {
    try {
        const createdById = req.headers["x-employee-id"];
        const result = await svc.createPath({ ...req.body, createdById, tenantId: tenantOf(req) });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const listPaths = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await svc.listPaths({ page: Number(page) || 1, limit: Number(limit) || 20, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { respondServerError(req, res, e); }
};

export const getPath = async (req, res) => {
    try {
        const result = await svc.getPath(req.params.id, tenantOf(req));
        if (!result) return res.status(404).json({ success: false, message: "Not found" });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const updatePath = async (req, res) => {
    try {
        const result = await svc.updatePath(req.params.id, req.body, tenantOf(req));
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const addCourseToPath = async (req, res) => {
    try {
        const result = await svc.addCourseToPath({ ...req.body, pathId: req.params.id, tenantId: tenantOf(req) });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const enrollEmployee = async (req, res) => {
    try {
        const result = await svc.enrollEmployee({ pathId: req.params.id, employeeId: req.body.employeeId, tenantId: tenantOf(req) });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
