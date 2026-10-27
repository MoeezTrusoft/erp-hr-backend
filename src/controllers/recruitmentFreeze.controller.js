// src/controllers/recruitmentFreeze.controller.js
//
// Phase 4 / decision record §2.7 — the hiring-freeze surface.
//
// Authorization for these routes does NOT come from here: the freeze endpoints
// live under `/api/recruitment/freeze`, which routeAuthorization maps to the
// dedicated `hr.recruitment.freeze` resource BEFORE the general
// `/api/recruitment` prefix. That ordering is the whole point — setting or
// lifting a freeze is not an ordinary recruitment write, so a recruiter's
// `hr.recruitment:update` grant must not carry it. The middleware is the only
// thing standing between those two, so the route prefix is asserted by a test.
import { resolveEmployeeActor } from "../lib/employeeActor.js";
import {
  liftHiringFreeze,
  listHiringFreezes,
  setHiringFreeze,
} from "../services/recruitment-freeze.service.js";

const tenantOf = (req) => req.user?.tenantId ?? null;
const actorOf = (req) => resolveEmployeeActor(req.user);

const respond = (res, error) => {
  const status = Number(error?.status) || 400;
  res.status(status).json({ success: false, message: error.message, code: error.code });
};

export const listHiringFreezesController = async (req, res) => {
  try {
    const includeInactive = ["1", "true"].includes(String(req.query?.includeInactive ?? "").toLowerCase());
    const data = await listHiringFreezes(tenantOf(req), { includeInactive });
    res.status(200).json({ success: true, data });
  } catch (error) {
    respond(res, error);
  }
};

export const setHiringFreezeController = async (req, res) => {
  try {
    const data = await setHiringFreeze(tenantOf(req), {
      ...req.body,
      createdById: await actorOf(req),
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    respond(res, error);
  }
};

export const liftHiringFreezeController = async (req, res) => {
  try {
    const data = await liftHiringFreeze(tenantOf(req), req.params.id, {
      reason: req.body?.reason,
      liftedById: await actorOf(req),
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    respond(res, error);
  }
};
