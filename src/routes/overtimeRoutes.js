import express from "express";
import {
    getOvertimeRules,
    createOvertimeRule,
    updateOvertimeRule,
    deleteOvertimeRule,
    calculateOvertime
} from "../controllers/overtimeController.js";


const router = express.Router();

router.get("/", getOvertimeRules);
router.post("/", createOvertimeRule);
router.put("/:id", updateOvertimeRule);
router.delete("/:id", deleteOvertimeRule);
router.get("/calculate", calculateOvertime);

export default router;