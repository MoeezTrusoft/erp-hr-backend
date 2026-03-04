import * as svc from "../services/talentPool.service.js";

export const listPools = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await svc.listPools({ page: Number(page) || 1, limit: Number(limit) || 20 });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

export const addToPool = async (req, res) => {
    try {
        const addedById = req.headers["x-employee-id"];
        const result = await svc.addToPool({ ...req.body, addedById });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const removeFromPool = async (req, res) => {
    try {
        await svc.removeFromPool(req.params.id);
        res.status(204).end();
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const getCandidatesInPool = async (req, res) => {
    try {
        const result = await svc.getCandidatesInPool(req.query.pool);
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
