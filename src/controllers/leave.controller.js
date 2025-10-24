import * as leaveService from "../services/leave.service.js";

export const requestLeave = async (req, res) => {
  try {
    const result = await leaveService.requestLeaveService(req.body);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const approveLeave = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await leaveService.approveLeaveService(id, req.body);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const getEmployeeLeaves = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await leaveService.getLeaveByEmployee(Number(id));
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
