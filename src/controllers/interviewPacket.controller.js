// src/controllers/interviewPacket.controller.js
//
// Phase 6 / decision record §4.4 — REST surface for the interview packet.
// Mounted under /api/recruitment like the rest of the §4 slice, so
// routeAuthorization resolves everything here to the hr.recruitment resource
// with the method-derived action — one policy model, nothing to drift.
//
// GET /:id/packet/me is the interviewer-context view: the matrix plus the
// assignment check decide what comes back, and a viewer who is not assigned
// gets an EMPTY packet (not an error) — the existence of a packet is not
// itself privileged information, but its contents are.

import {
    addPacketItem,
    removePacketItem,
    listPacket,
    getPacketForViewer,
    PacketError,
} from "../services/interview-packet.service.js";

const tenantOf = (req) => req.user?.tenantId ?? null;
const actorOf = (req) => req.user?.employeeId ?? null;

const respond = (res, error) => {
    const status = Number(error?.status) || 400;
    const body = { success: false, message: error.message, code: error.code };
    if (error?.details !== undefined) body.details = error.details;
    return res.status(status).json(body);
};

export const addPacketItemHandler = async (req, res) => {
    try {
        const { docClass, mediaId, label } = req.body ?? {};
        const result = await addPacketItem({
            interviewId: req.params.id,
            docClass,
            mediaId,
            label: label ?? null,
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });
        res.status(result.alreadyListed ? 200 : 201).json({ success: true, data: result });
    } catch (error) {
        respond(res, error);
    }
};

export const listPacketHandler = async (req, res) => {
    try {
        const rows = await listPacket({ interviewId: req.params.id, tenantId: tenantOf(req) });
        res.status(200).json({ success: true, data: rows });
    } catch (error) {
        respond(res, error);
    }
};

export const removePacketItemHandler = async (req, res) => {
    try {
        const row = await removePacketItem({
            interviewId: req.params.id,
            itemId: req.params.itemId,
            tenantId: tenantOf(req),
            actorId: actorOf(req),
        });
        res.status(200).json({ success: true, data: row });
    } catch (error) {
        respond(res, error);
    }
};

export const myPacketViewHandler = async (req, res) => {
    try {
        const view = await getPacketForViewer({
            interviewId: req.params.id,
            tenantId: tenantOf(req),
            viewerEmployeeId: actorOf(req),
        });
        res.status(200).json({ success: true, data: view });
    } catch (error) {
        respond(res, error);
    }
};

export { PacketError };
