// Recruitment Phase 7 (B5) — panel roles in scheduling.
//
//   * normalizePanelRoles validates the vocabulary and the panel membership;
//   * scheduling stores a role per panelist (none = every section);
//   * setInterviewPanelRoles changes roles only before the interview starts,
//     for recruiters and the requisition's own hiring manager, with the
//     interview_updated event and the panel's display names;
//   * everything is behind the evaluationForms flag.
import { describe, it, expect, beforeEach, afterAll, jest } from "@jest/globals";

const prisma = {
    interview: { findFirst: jest.fn() },
    interviewInterviewer: { updateMany: jest.fn() },
    employee: { findMany: jest.fn() },
};
const logAction = jest.fn(async () => undefined);
const enqueueHrDomainEvent = jest.fn(async () => null);

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({ tenantTransaction: (client, fn) => fn(client) }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));

const service = await import("../../../src/services/interviewSchedule.service.js");
const { resolveRecruitmentScope } = await import("../../../src/lib/recruitmentAccess.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-27T09:00:00Z");
const FLAG = "HR_RECRUITMENT_EVALUATION_FORMS";
const saved = process.env[FLAG];

const ORG = resolveRecruitmentScope({ roles: ["RECRUITER"], employeeId: 9 });
const MANAGED = resolveRecruitmentScope({ roles: ["HIRING_MANAGER"], employeeId: 7 });
const ASSIGNED = resolveRecruitmentScope({ roles: ["INTERVIEWER"], employeeId: 3 });

const interview = (over = {}) => ({
    id: 500,
    tenantId: TENANT,
    applicationId: 900,
    scheduledAt: new Date("2026-10-29T06:00:00Z"),
    status: "SCHEDULED",
    decision: null,
    interviewers: [{ employeeId: 3, panelRole: null }, { employeeId: 4, panelRole: "HR" }],
    application: { candidateId: 77 },
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    process.env[FLAG] = "true";
    prisma.interview.findFirst.mockResolvedValue(interview());
    prisma.interviewInterviewer.updateMany.mockResolvedValue({ count: 1 });
    prisma.employee.findMany.mockResolvedValue([
        { id: 3, first_name: "Ayesha", last_name: "Khan", employee_name: null },
        { id: 4, first_name: null, last_name: null, employee_name: "Bilal Ahmed" },
    ]);
});

afterAll(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
});

describe("normalizePanelRoles", () => {
    it("accepts a list or a map, upper-cases roles and keeps a null as a clear", () => {
        expect([...service.normalizePanelRoles([{ employeeId: "3", panelRole: "technical" }, { employeeId: 4, panelRole: null }], [3, 4])])
            .toEqual([[3, "TECHNICAL"], [4, null]]);
        expect([...service.normalizePanelRoles({ 3: "CULTURE" }, [3])]).toEqual([[3, "CULTURE"]]);
        expect(service.normalizePanelRoles(undefined).size).toBe(0);
    });

    it("refuses an unknown role, a non-panelist, a duplicate and a missing id", () => {
        expect(() => service.normalizePanelRoles([{ employeeId: 3, panelRole: "JUDGE" }], [3])).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PANEL-ROLE-INVALID", status: 400 }));
        expect(() => service.normalizePanelRoles([{ employeeId: 8, panelRole: "HR" }], [3])).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PANEL-ROLE-NOT-PANELIST" }));
        expect(() => service.normalizePanelRoles([{ employeeId: 3, panelRole: "HR" }, { employeeId: 3, panelRole: "CULTURE" }], [3])).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PANEL-ROLE-INVALID" }));
        expect(() => service.normalizePanelRoles([{ panelRole: "HR" }], [3])).toThrow(expect.objectContaining({ code: "HR-RECRUITMENT-PANEL-ROLE-INVALID" }));
    });
});

describe("setInterviewPanelRoles", () => {
    const call = (over = {}) => service.setInterviewPanelRoles({
        interviewId: 500,
        roles: [{ employeeId: 3, panelRole: "TECHNICAL" }],
        tenantId: TENANT,
        actorId: 9,
        scope: ORG,
        now: NOW,
        ...over,
    });

    it("sets a role, announces the change and returns the panel with names", async () => {
        const result = await call();
        expect(prisma.interviewInterviewer.updateMany).toHaveBeenCalledWith({
            where: { interviewId: 500, employeeId: 3, tenantId: TENANT },
            data: { panelRole: "TECHNICAL" },
        });
        expect(result).toEqual({
            interviewId: 500,
            changed: 1,
            panel: [
                { employeeId: 3, employeeName: "Ayesha Khan", panelRole: "TECHNICAL" },
                { employeeId: 4, employeeName: "Bilal Ahmed", panelRole: "HR" },
            ],
        });
        expect(enqueueHrDomainEvent).toHaveBeenCalledTimes(1);
        const event = enqueueHrDomainEvent.mock.calls[0][1];
        expect(event.eventName).toBe("hr.recruitment.interview_updated.v1");
        expect(event.payload).toMatchObject({ interviewId: "500", changedFields: ["panelRoles"], interviewerIds: ["3", "4"] });
        expect(JSON.stringify(event.payload)).not.toMatch(/Ayesha|TECHNICAL/);
        expect(logAction).toHaveBeenCalledTimes(1);
    });

    it("clearing a role writes null; an unchanged role writes nothing and announces nothing", async () => {
        const cleared = await call({ roles: [{ employeeId: 4, panelRole: null }] });
        expect(prisma.interviewInterviewer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { panelRole: null } }));
        expect(cleared.panel[1].panelRole).toBeNull();

        jest.clearAllMocks();
        prisma.interview.findFirst.mockResolvedValue(interview());
        prisma.employee.findMany.mockResolvedValue([]);
        const same = await call({ roles: [{ employeeId: 4, panelRole: "HR" }] });
        expect(same.changed).toBe(0);
        expect(prisma.interviewInterviewer.updateMany).not.toHaveBeenCalled();
        expect(enqueueHrDomainEvent).not.toHaveBeenCalled();
        expect(same.panel[0].employeeName).toBeNull();
    });

    it("refuses once the interview has started or is no longer scheduled", async () => {
        prisma.interview.findFirst.mockResolvedValue(interview({ scheduledAt: new Date("2026-10-27T08:00:00Z") }));
        await expect(call()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-PANEL-ROLE-LOCKED" });
        prisma.interview.findFirst.mockResolvedValue(interview({ status: "CANCELLED" }));
        await expect(call()).rejects.toMatchObject({ status: 409, code: "HR-RECRUITMENT-PANEL-ROLE-LOCKED" });
        expect(prisma.interviewInterviewer.updateMany).not.toHaveBeenCalled();
    });

    it("a hiring manager is narrowed to their own requisitions; a panelist is refused", async () => {
        await call({ scope: MANAGED });
        expect(prisma.interview.findFirst.mock.calls[0][0].where).toMatchObject({
            id: 500, tenantId: TENANT, application: { jobRequisition: { requestedById: 7 } },
        });
        await expect(call({ scope: ASSIGNED })).rejects.toMatchObject({ status: 403, code: "HR-RECRUITMENT-PANEL-ROLE-FORBIDDEN" });
    });

    it("an unknown or out-of-scope interview is not found; a non-panelist is refused", async () => {
        prisma.interview.findFirst.mockResolvedValueOnce(null);
        await expect(call()).rejects.toMatchObject({ status: 404, code: "HR-RECRUITMENT-SCHEDULE-NOT-FOUND" });
        await expect(call({ roles: [{ employeeId: 99, panelRole: "HR" }] })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-PANEL-ROLE-NOT-PANELIST" });
    });

    it("answers 503 -DISABLED with evaluation forms off, and 400 on an empty list", async () => {
        process.env[FLAG] = "false";
        await expect(call()).rejects.toMatchObject({ status: 503, code: "HR-RECRUITMENT-EVALUATION-FORMS-DISABLED" });
        process.env[FLAG] = "true";
        await expect(call({ roles: [] })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-PANEL-ROLE-INVALID" });
        expect(prisma.interview.findFirst).not.toHaveBeenCalled();
    });
});
