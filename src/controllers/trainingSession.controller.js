import * as svc from "../services/trainingSession.service.js";

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped training-session service so tenant B cannot read/mutate tenant A's
// sessions. createSession is fail-closed (requireTenant) in the service.
const tenantOf = (req) => req.user?.tenantId;

export const createSession = async (req, res) => {
    try {
        const result = await svc.createSession({ ...req.body, tenantId: tenantOf(req) });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const listSessions = async (req, res) => {
    try {
        const { courseId, page, limit } = req.query;
        const result = await svc.listSessions({ courseId, page: Number(page) || 1, limit: Number(limit) || 20, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

export const updateSession = async (req, res) => {
    try {
        const result = await svc.updateSession(req.params.id, req.body, tenantOf(req));
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const markAttendance = async (req, res) => {
    try {
        const employeeId = req.body.employeeId || req.headers["x-employee-id"];
        const result = await svc.markAttendance({ sessionId: req.params.id, employeeId, attended: req.body.attended, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const uploadRecording = async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }
        const result = await svc.uploadRecording(req.params.id, req.files[0], tenantOf(req));
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
