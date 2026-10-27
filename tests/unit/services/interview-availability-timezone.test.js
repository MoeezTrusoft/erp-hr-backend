// Recruitment Phase 7 (B18a) — the non-working-day warning counts the slot's
// weekday in the tenant's recruitment time zone, not in UTC. A Friday 23:30
// UTC slot is Saturday 04:30 in Asia/Karachi, so an interviewer who works
// Monday to Friday is outside their schedule there.
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const prisma = {
    interview: { findFirst: jest.fn(), update: jest.fn() },
    interviewLifecycleEvent: { create: jest.fn() },
    leaveRequest: { findMany: jest.fn() },
    workSchedule: { findMany: jest.fn() },
    tenantRecruitmentSettings: { findFirst: jest.fn() },
};

jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));
jest.unstable_mockModule("../../../src/lib/rlsTenant.js", () => ({ tenantTransaction: (client, fn) => fn(client) }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn(async () => null) }));

const service = await import("../../../src/services/interview-schedule.service.js");
const { RECRUITMENT_SETTINGS_DEFAULTS } = await import("../../../src/services/recruitment-settings.service.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
// 2026-10-30 is a Friday.
const FRIDAY_LATE_UTC = "2026-10-30T23:30:00Z";
const WEEKDAYS_ONLY = {
    monday: "09:00-18:00", tuesday: "09:00-18:00", wednesday: "09:00-18:00", thursday: "09:00-18:00", friday: "09:00-18:00",
    saturday: "", sunday: "",
};

beforeEach(() => {
    jest.clearAllMocks();
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    prisma.workSchedule.findMany.mockResolvedValue([
        { employeeId: 3, schedule_pattern: WEEKDAYS_ONLY },
    ]);
    prisma.tenantRecruitmentSettings.findFirst.mockResolvedValue(null);
});

describe("weekdayKeyInZone", () => {
    it("is Saturday in Asia/Karachi and Friday in UTC for Friday 23:30 UTC", () => {
        expect(service.weekdayKeyInZone(new Date(FRIDAY_LATE_UTC), "Asia/Karachi")).toBe("saturday");
        expect(service.weekdayKeyInZone(new Date(FRIDAY_LATE_UTC), "UTC")).toBe("friday");
    });

    it("the default zone matches the settings default", () => {
        expect(service.DEFAULT_TENANT_TIME_ZONE).toBe(RECRUITMENT_SETTINGS_DEFAULTS.timeZone);
    });
});

describe("checkInterviewerAvailability × tenant time zone", () => {
    it("flags a Monday-Friday interviewer on a Friday 23:30 UTC slot in Asia/Karachi", async () => {
        prisma.tenantRecruitmentSettings.findFirst.mockResolvedValue({ timeZone: "Asia/Karachi" });
        const result = await service.checkInterviewerAvailability({
            scheduledAt: FRIDAY_LATE_UTC, interviewerIds: [3], tenantId: TENANT,
        });
        expect(result).toEqual({ blocked: [], nonWorkingDay: [3], timeZone: "Asia/Karachi" });
        expect(prisma.tenantRecruitmentSettings.findFirst).toHaveBeenCalledWith({ where: { tenantId: TENANT }, select: { timeZone: true } });
    });

    it("a tenant without a settings row uses the default zone (Asia/Karachi)", async () => {
        const result = await service.checkInterviewerAvailability({
            scheduledAt: FRIDAY_LATE_UTC, interviewerIds: [3], tenantId: TENANT,
        });
        expect(result.timeZone).toBe("Asia/Karachi");
        expect(result.nonWorkingDay).toEqual([3]);
    });

    it("a tenant working in UTC sees the same slot as a Friday (no warning)", async () => {
        prisma.tenantRecruitmentSettings.findFirst.mockResolvedValue({ timeZone: "UTC" });
        const result = await service.checkInterviewerAvailability({
            scheduledAt: FRIDAY_LATE_UTC, interviewerIds: [3], tenantId: TENANT,
        });
        expect(result).toEqual({ blocked: [], nonWorkingDay: [], timeZone: "UTC" });
    });

    it("an invalid stored zone or a failed read falls back to the default instead of failing", async () => {
        prisma.tenantRecruitmentSettings.findFirst.mockResolvedValueOnce({ timeZone: "Mars/Olympus" });
        await expect(service.checkInterviewerAvailability({ scheduledAt: FRIDAY_LATE_UTC, interviewerIds: [3], tenantId: TENANT }))
            .resolves.toMatchObject({ timeZone: "Asia/Karachi", nonWorkingDay: [3] });
        prisma.tenantRecruitmentSettings.findFirst.mockRejectedValueOnce(new Error("db down"));
        await expect(service.checkInterviewerAvailability({ scheduledAt: FRIDAY_LATE_UTC, interviewerIds: [3], tenantId: TENANT }))
            .resolves.toMatchObject({ timeZone: "Asia/Karachi", nonWorkingDay: [3] });
    });

    it("a client without the settings model keeps the UTC rule", async () => {
        const zone = await service.tenantScheduleTimeZone({}, TENANT);
        expect(zone).toBe("UTC");
    });

    it("no interviewers: nothing is read but the zone is still reported", async () => {
        const result = await service.checkInterviewerAvailability({ scheduledAt: FRIDAY_LATE_UTC, interviewerIds: [], tenantId: TENANT });
        expect(result).toEqual({ blocked: [], nonWorkingDay: [], timeZone: "Asia/Karachi" });
        expect(prisma.workSchedule.findMany).not.toHaveBeenCalled();
    });
});

describe("confirmReschedule × tenant time zone", () => {
    const interview = {
        id: 500, tenantId: TENANT, applicationId: 900, scheduledAt: new Date("2026-10-28T06:00:00Z"), status: "SCHEDULED",
        durationMinutes: 60, calendarEventId: null, interviewers: [{ employeeId: 3 }], application: { candidateId: 77 },
    };

    it("a Friday 23:30 UTC move needs the non-working-day override in Asia/Karachi", async () => {
        prisma.interview.findFirst.mockResolvedValue(interview);
        prisma.tenantRecruitmentSettings.findFirst.mockResolvedValue({ timeZone: "Asia/Karachi" });
        await expect(service.confirmReschedule({
            interviewId: 500, scheduledAt: FRIDAY_LATE_UTC, reasonCode: "CANDIDATE_REQUEST", tenantId: TENANT,
        })).rejects.toMatchObject({
            status: 400,
            details: { code: "HR-RECRUITMENT-SCHEDULE-OVERRIDE-REASON-REQUIRED", nonWorkingDayInterviewerIds: [3] },
        });
        expect(prisma.interview.update).not.toHaveBeenCalled();
    });

    it("the same move goes through for a tenant on UTC", async () => {
        prisma.interview.findFirst.mockResolvedValue(interview);
        prisma.interview.update.mockResolvedValue({ id: 500 });
        prisma.interviewLifecycleEvent.create.mockResolvedValue({ id: 1 });
        prisma.tenantRecruitmentSettings.findFirst.mockResolvedValue({ timeZone: "UTC" });
        const row = await service.confirmReschedule({
            interviewId: 500, scheduledAt: FRIDAY_LATE_UTC, reasonCode: "CANDIDATE_REQUEST", tenantId: TENANT,
        });
        expect(row.newScheduledAt.toISOString()).toBe("2026-10-30T23:30:00.000Z");
    });
});
