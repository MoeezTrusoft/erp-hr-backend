import * as svc from "../services/talentPool.service.js";
import { respondServerError } from '../utils/httpError.js';

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped talent-pool service so tenant B cannot read/mutate tenant A's pools.
const tenantOf = (req) => req.user?.tenantId;

export const listPools = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await svc.listPools({ page: Number(page) || 1, limit: Number(limit) || 20, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { respondServerError(req, res, e); }
};

export const addToPool = async (req, res) => {
    try {
        const addedById = req.headers["x-employee-id"];
        const result = await svc.addToPool({ ...req.body, addedById, tenantId: tenantOf(req) });
        res.status(201).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const removeFromPool = async (req, res) => {
    try {
        await svc.removeFromPool(req.params.id, tenantOf(req));
        res.status(204).end();
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};

export const getCandidatesInPool = async (req, res) => {
    try {
        const result = await svc.getCandidatesInPool(req.query.pool, tenantOf(req));
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
