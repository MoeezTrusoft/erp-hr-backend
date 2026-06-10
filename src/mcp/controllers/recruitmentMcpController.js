import { runController } from "./_runner.js";
import {
  createRequisitionController,
  getRequisitionsController,
  approveRequisitionController,
  postRequisitionController,
  deletRequisitionsController,
  updateRequisitionController,
} from "../../controllers/requisition.controller.js";
import { createCandidate, updateCandidate, listCandidates } from "../../controllers/candidateController.js";
import { createApplication, listApplications, updateStage, updateStatus } from "../../controllers/applicationController.js";
import { listTags } from "../../controllers/tagController.js";
import { listPools, addToPool, removeFromPool } from "../../controllers/talentPool.controller.js";
import { scheduleInterview, listInterviews, updateInterview } from "../../controllers/interview.controller.js";
import { createOffer, updateOffer, listOffers, sendOffer } from "../../controllers/offer.controller.js";

export const mcpListRequisitions = (user) => runController(getRequisitionsController, { user });
export const mcpListCandidates = (user) => runController(listCandidates, { user });
export const mcpListApplications = (user) => runController(listApplications, { user });
export const mcpListTalentPool = (user) => runController(listPools, { user });
export const mcpListRecruitmentTags = (user) => runController(listTags, { user });
export const mcpListInterviews = (user) => runController(listInterviews, { user });
export const mcpListOffers = (user) => runController(listOffers, { user });

export const mcpCreateRequisition = (user, data) => runController(createRequisitionController, { user, body: data });
export const mcpUpdateRequisition = (user, id, data) => runController(updateRequisitionController, { user, params: { id: String(id) }, body: data });
export const mcpApproveRequisition = (user, id, data) => runController(approveRequisitionController, { user, params: { id: String(id) }, body: data });
export const mcpPostRequisition = (user, id, data) => runController(postRequisitionController, { user, params: { id: String(id) }, body: data });
export const mcpDeleteRequisition = (user, id) => runController(deletRequisitionsController, { user, params: { id: String(id) } });

export const mcpCreateCandidate = (user, data) => runController(createCandidate, { user, body: data });
export const mcpUpdateCandidate = (user, id, data) => runController(updateCandidate, { user, params: { id: String(id) }, body: data });

export const mcpCreateApplication = (user, data) => runController(createApplication, { user, body: data });
export const mcpUpdateApplicationStage = (user, id, data) => runController(updateStage, { user, params: { id: String(id) }, body: data });
export const mcpUpdateApplicationStatus = (user, id, data) => runController(updateStatus, { user, params: { id: String(id) }, body: data });

export const mcpCreateInterview = (user, data) => runController(scheduleInterview, { user, body: data });
export const mcpUpdateInterview = (user, id, data) => runController(updateInterview, { user, params: { id: String(id) }, body: data });

export const mcpCreateOffer = (user, data) => {
  const body = {
    ...data,
    salary: data.salary !== undefined ? data.salary : data.baseSalary,
    notes: data.notes !== undefined ? data.notes : data.benefits,
  };
  return runController(createOffer, { user, body });
};
export const mcpUpdateOffer = (user, id, data) => {
  const body = {
    ...data,
    salary: data.salary !== undefined ? data.salary : data.baseSalary,
    notes: data.notes !== undefined ? data.notes : data.benefits,
  };
  return runController(updateOffer, { user, params: { id: String(id) }, body });
};
export const mcpSendOffer = (user, id) => runController(sendOffer, { user, params: { id: String(id) } });
export const mcpAddTalentPool = (user, data) => runController(addToPool, { user, body: data });
export const mcpRemoveTalentPool = (user, id) => runController(removeFromPool, { user, params: { id: String(id) } });
