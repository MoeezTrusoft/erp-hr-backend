import * as svc from "../services/talentPool.service.js";
import {
    listInvitations as listInvitationsSvc,
    respondToInvitation,
    segmentTalentPool,
    sweepTalentPoolRetention,
    withdrawInvitation,
} from "../services/talentPoolInvitation.service.js";
import { respondServerError } from '../utils/httpError.js';
import { resolveEmployeeActor } from "../lib/employeeActor.js";

// C.2-completion — verified tenant (req.user.tenantId; T-P2.1) threaded into the
// scoped talent-pool service so tenant B cannot read/mutate tenant A's pools.
const tenantOf = (req) => req.user?.tenantId;

// T-P2.1 / F-07 — `addedById` is audit attribution, so it comes from the verified
// claim like every other Recruitment actor. It was read from the `x-employee-id`
// header, which a caller fully controls and which the MCP path never sends.
const actorOf = (req) => resolveEmployeeActor(req.user);

export const listPools = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await svc.listPools({ page: Number(page) || 1, limit: Number(limit) || 20, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { respondServerError(req, res, e); }
};

export const addToPool = async (req, res) => {
    try {
        const addedById = await actorOf(req);
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

// ── FR-10 residue: invitation lifecycle, segmentation, pool retention sweep ──
//
// The REST mirror of the MCP surface. Both call the same service, so the
// lifecycle rules cannot differ by which door the caller used.

export const listInvitations = async (req, res) => {
    try {
        const result = await listInvitationsSvc({
            tenantId: tenantOf(req),
            status: req.query?.status ?? null,
            candidateId: req.query?.candidateId ?? null,
            limit: req.query?.limit,
        });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(e.status || 400).json({ success: false, message: e.message, code: e.code }); }
};

export const respondToInvitationCtrl = async (req, res) => {
    try {
        const action = String(req.body?.action ?? "respond").trim().toLowerCase();
        if (!["respond", "withdraw"].includes(action)) {
            return res.status(400).json({ success: false, message: "action must be respond or withdraw" });
        }
        const result = action === "withdraw"
            ? await withdrawInvitation({
                tenantId: tenantOf(req),
                invitationId: req.params.id,
                reason: req.body?.note ?? null,
            })
            : await respondToInvitation({
                tenantId: tenantOf(req),
                invitationId: req.params.id,
                response: req.body?.response,
                note: req.body?.note ?? null,
            });
        res.status(200).json({ success: true, data: result });
    } catch (e) { res.status(e.status || 400).json({ success: false, message: e.message, code: e.code }); }
};

export const segmentPool = async (req, res) => {
    try {
        // Filters arrive in the body so an array of skills does not have to be
        // encoded into a query string.
        const { limit, ...filters } = req.body ?? {};
        const result = await segmentTalentPool({ tenantId: tenantOf(req), filters, limit });
        res.status(200).json({ success: true, message: "Success", data: result });
    } catch (e) { res.status(e.status || 400).json({ success: false, message: e.message, code: e.code }); }
};

export const retentionSweep = async (req, res) => {
    try {
        const result = await sweepTalentPoolRetention({
            tenantId: tenantOf(req),
            asOf: req.body?.asOf ? new Date(req.body.asOf) : new Date(),
            // Apply has to be asked for explicitly: the default is the safe read.
            dryRun: req.body?.dryRun !== false,
            limit: req.body?.limit,
            actorId: await actorOf(req),
        });
        res.status(200).json({ success: true, data: result });
    } catch (e) { res.status(e.status || 400).json({ success: false, message: e.message, code: e.code }); }
};
