// tests/unit/interviewSchedule.service.test.js
//
// Phase 7 / decision record §5.1a–5.4 — the lifecycle service:
//
//   * §5.4  cancel writes the CODED lifecycle row + event + audit; a completed
//           or already-cancelled interview refuses (409)
//   * §5.3  a candidate request records RESCHEDULE_REQUESTED and routes to the
//           requisition owner — the panel event is deliberately absent
//   * §5.3a the panel event fires ONLY on confirmReschedule
//   * §5.2a confirm runs the availability gate: approved leave = 409 hard
//           block; non-working-day = override + reason or 400
//   * §5.1a markCalendarSync stamps the linkage, never the event content

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const prisma = {
    interview: { findFirst: jest.fn(), update: jest.fn() },
    interviewLifecycleEvent: { create: jest.fn(), findMany: jest.fn() },
    leaveRequest: { findMany: jest.fn() },
    workSchedule: { findMany: jest.fn() },
    $transaction: jest.fn(),
};
const logAction = jest.fn(async () => undefined);
const enqueueHrDomainEvent = jest.fn(async () => undefined);

jest.unstable_mockModule("../../src/config/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../src/utils/logs.js", () => ({ logAction }));
jest.unstable_mockModule("../../src/lib/rlsTenant.js", () => ({
    tenantTransaction: (client, fn) => fn(client),
}));
jest.unstable_mockModule("../../src/services/hrDomainEvent.service.js", () => ({
    enqueueHrDomainEvent,
}));

const service = await import("../../src/services/interviewSchedule.service.js");

const tenant = "t-1";

const interviewRow = (overrides = {}) => ({
    id: 500,
    tenantId: tenant,
    applicationId: 900,
    scheduledAt: new Date("2026-10-01T09:00:00Z"),
    status: "SCHEDULED",
    durationMinutes: 60,
    interviewers: [{ employeeId: 3 }, { employeeId: 4 }],
    application: { candidateId: 77, jobRequisition: { requestedById: 7 } },
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    logAction.mockResolvedValue(undefined);
    enqueueHrDomainEvent.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
});

// ── §5.4 cancel ──────────────────────────────────────────────────────────────

describe("interviewSchedule.cancelInterview (§5.4)", () => {
    it("cancels with a coded reason: status + ledger row + event + audit", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        prisma.interview.update.mockResolvedValue({ id: 500 });
        prisma.interviewLifecycleEvent.create.mockResolvedValue({ id: 1 });

        const row = await service.cancelInterview({
            interviewId: 500,
            reasonCode: "INTERVIEWER_CONFLICT",
            notes: null,
            tenantId: tenant,
            actorId: 12,
        });

        expect(row).toMatchObject({ interviewId: 500, status: "CANCELLED", reasonCode: "INTERVIEWER_CONFLICT" });
        expect(prisma.interview.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: "CANCELLED" } }),
        );
        expect(prisma.interviewLifecycleEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ eventType: "CANCELLED", reasonCode: "INTERVIEWER_CONFLICT", actorId: 12 }),
            }),
        );
        expect(enqueueHrDomainEvent).toHaveBeenCalledTimes(1);
        expect(logAction).toHaveBeenCalledTimes(1);
    });

    it("OTHER without notes refuses before any write", async () => {
        await expect(
            service.cancelInterview({ interviewId: 500, reasonCode: "OTHER", notes: "  ", tenantId: tenant }),
        ).rejects.toMatchObject({ status: 400, details: { code: "HR-RECRUITMENT-SCHEDULE-REASON-INVALID" } });
        expect(prisma.interview.update).not.toHaveBeenCalled();
    });

    it("a COMPLETED interview refuses with 409", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow({ status: "COMPLETED" }));
        await expect(
            service.cancelInterview({ interviewId: 500, reasonCode: "BUSINESS_REQUEST", tenantId: tenant }),
        ).rejects.toMatchObject({ status: 409, details: "HR-RECRUITMENT-SCHEDULE-COMPLETED" });
        expect(prisma.interview.update).not.toHaveBeenCalled();
    });

    it("an already-CANCELLED interview refuses with 409", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow({ status: "CANCELLED" }));
        await expect(
            service.cancelInterview({ interviewId: 500, reasonCode: "BUSINESS_REQUEST", tenantId: tenant }),
        ).rejects.toMatchObject({ status: 409, details: "HR-RECRUITMENT-SCHEDULE-ALREADY-CANCELLED" });
    });

    it("an unknown interview 404s without writing", async () => {
        prisma.interview.findFirst.mockResolvedValue(null);
        await expect(
            service.cancelInterview({ interviewId: 404, reasonCode: "BUSINESS_REQUEST", tenantId: tenant }),
        ).rejects.toMatchObject({ status: 404, details: "HR-RECRUITMENT-SCHEDULE-NOT-FOUND" });
    });

    it("Phase 3b: a passed db is used as-is, so a test release can compose the cancel", async () => {
        const db = {
            interview: { findFirst: jest.fn(async () => interviewRow()), update: jest.fn(async () => ({ id: 500 })) },
            interviewLifecycleEvent: { create: jest.fn(async () => ({ id: 3 })) },
        };
        const row = await service.cancelInterview({
            interviewId: 500,
            reasonCode: "ASSESSMENT_NOT_PASSED",
            tenantId: tenant,
            actorId: 12,
            db,
        });
        expect(row).toMatchObject({ status: "CANCELLED", reasonCode: "ASSESSMENT_NOT_PASSED" });
        expect(db.interview.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "CANCELLED" } }));
        expect(prisma.interview.update).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});

// ── §5.3 request ─────────────────────────────────────────────────────────────

describe("interviewSchedule.requestReschedule (§5.3)", () => {
    it("records the request and routes to the requisition owner — no panel event", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        prisma.interviewLifecycleEvent.create.mockResolvedValue({ id: 2 });

        const row = await service.requestReschedule({
            interviewId: 500,
            reasonCode: "CANDIDATE_REQUEST",
            requestedFor: "2026-10-04T10:00:00Z",
            tenantId: tenant,
            actorId: 77,
        });

        expect(row).toMatchObject({ interviewId: 500, requestedFor: "2026-10-04T10:00:00.000Z" });
        expect(prisma.interviewLifecycleEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ eventType: "RESCHEDULE_REQUESTED", reasonCode: "CANDIDATE_REQUEST" }),
            }),
        );
        // Exactly ONE event, and its payload carries the recruiter id but NO
        // interviewerIds — §5.3a's no-panel-churn contract, enforced in shape.
        expect(enqueueHrDomainEvent).toHaveBeenCalledTimes(1);
        const ev = enqueueHrDomainEvent.mock.calls[0][1];
        expect(ev.payload.recruiterId).toBe(7);
        expect(ev.payload.interviewerIds).toBeUndefined();
        expect(ev.eventName).toBe("hr.recruitment.interview_reschedule_requested.v1");
    });

    it("a terminal interview refuses", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow({ status: "CANCELLED" }));
        await expect(
            service.requestReschedule({ interviewId: 500, reasonCode: "CANDIDATE_REQUEST", tenantId: tenant }),
        ).rejects.toMatchObject({ status: 409 });
    });

    it("Phase 3b: ASSESSMENT_NOT_PASSED is a cancel reason only, never a reschedule reason", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        await expect(
            service.requestReschedule({ interviewId: 500, reasonCode: "ASSESSMENT_NOT_PASSED", tenantId: tenant }),
        ).rejects.toMatchObject({ status: 400, details: { code: "HR-RECRUITMENT-SCHEDULE-REASON-INVALID" } });
        await expect(
            service.confirmReschedule({
                interviewId: 500, scheduledAt: "2026-10-05T09:00:00Z", reasonCode: "ASSESSMENT_NOT_PASSED", tenantId: tenant,
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect(prisma.interviewLifecycleEvent.create).not.toHaveBeenCalled();
        expect(prisma.interview.update).not.toHaveBeenCalled();
    });
});

// ── §5.2a confirm gate ───────────────────────────────────────────────────────

describe("interviewSchedule.confirmReschedule (§5.2/5.2a)", () => {
    const slot = "2026-10-04T09:00:00Z";

    it("moves the time, writes the ledger and fires the panel event — only here", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        prisma.interview.update.mockResolvedValue({ id: 500 });
        prisma.interviewLifecycleEvent.create.mockResolvedValue({ id: 3 });
        prisma.leaveRequest.findMany.mockResolvedValue([]);
        prisma.workSchedule.findMany.mockResolvedValue([]);

        const row = await service.confirmReschedule({
            interviewId: 500,
            scheduledAt: slot,
            reasonCode: "CANDIDATE_REQUEST",
            tenantId: tenant,
            actorId: 12,
        });

        expect(row.newScheduledAt).toEqual(new Date(slot));
        expect(prisma.interview.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ scheduledAt: new Date(slot), calendarSyncStatus: "PENDING" }) }),
        );
        const ev = enqueueHrDomainEvent.mock.calls[0][1];
        expect(ev.eventName).toBe("hr.recruitment.interview_rescheduled.v1");
        // ids travel as strings per the event payload contract.
        expect(ev.payload.interviewerIds).toEqual(["3", "4"]);
    });

    it("APPROVED leave on the new slot is a HARD 409 — no override path exists", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        prisma.leaveRequest.findMany.mockResolvedValue([
            { employeeId: 4, startDate: new Date("2026-10-04T00:00:00Z"), endDate: new Date("2026-10-05T00:00:00Z") },
        ]);
        prisma.workSchedule.findMany.mockResolvedValue([]);

        await expect(
            service.confirmReschedule({
                interviewId: 500,
                scheduledAt: slot,
                reasonCode: "CANDIDATE_REQUEST",
                override: true,
                overrideReason: "Even approved leave must not be overridden",
                tenantId: tenant,
            }),
        ).rejects.toMatchObject({
            status: 409,
            details: { code: "HR-RECRUITMENT-SCHEDULE-LEAVE-BLOCK", blockedInterviewerIds: [4] },
        });
        expect(prisma.interview.update).not.toHaveBeenCalled();
    });

    it("a non-working-day conflict requires override + reason", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        prisma.leaveRequest.findMany.mockResolvedValue([]);
        // Interviewer 3's effective schedule marks Sunday off.
        prisma.workSchedule.findMany.mockResolvedValue([
            { employeeId: 3, schedule_pattern: { sunday: "", monday: "09:00-17:00" } },
        ]);
        prisma.interview.update.mockResolvedValue({ id: 500 });
        prisma.interviewLifecycleEvent.create.mockResolvedValue({ id: 4 });

        // 2026-10-04 is a Sunday.
        await expect(
            service.confirmReschedule({ interviewId: 500, scheduledAt: slot, reasonCode: "BUSINESS_REQUEST", tenantId: tenant }),
        ).rejects.toMatchObject({ status: 400, details: { code: "HR-RECRUITMENT-SCHEDULE-OVERRIDE-REASON-REQUIRED" } });

        await expect(
            service.confirmReschedule({
                interviewId: 500, scheduledAt: slot, reasonCode: "BUSINESS_REQUEST",
                override: true, overrideReason: undefined, tenantId: tenant,
            }),
        ).rejects.toMatchObject({ status: 400 });

        const row = await service.confirmReschedule({
            interviewId: 500, scheduledAt: slot, reasonCode: "BUSINESS_REQUEST",
            override: true, overrideReason: "Quarter-end panel", tenantId: tenant, actorId: 12,
        });
        expect(row.interviewId).toBe(500);
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ notes: expect.stringContaining("overridden") }));
    });

    it("a working-day schedule pattern is not a conflict", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        prisma.leaveRequest.findMany.mockResolvedValue([]);
        prisma.workSchedule.findMany.mockResolvedValue([
            { employeeId: 3, schedule_pattern: { sunday: "10:00-16:00" } },
        ]);
        prisma.interview.update.mockResolvedValue({ id: 500 });
        prisma.interviewLifecycleEvent.create.mockResolvedValue({ id: 5 });

        const row = await service.confirmReschedule({
            interviewId: 500, scheduledAt: slot, reasonCode: "BUSINESS_REQUEST", tenantId: tenant,
        });
        expect(row.interviewId).toBe(500);
    });
});

// ── §5.1a calendar linkage ───────────────────────────────────────────────────

describe("interviewSchedule.markCalendarSync (§5.1a)", () => {
    it("stamps provider + event id + status", async () => {
        prisma.interview.findFirst.mockResolvedValue({ id: 500 });
        prisma.interview.update.mockResolvedValue({
            id: 500, calendarProvider: "OUTLOOK_365", calendarEventId: "evt-9",
            calendarSyncStatus: "SYNCED", calendarSyncedAt: new Date(),
        });

        const row = await service.markCalendarSync({
            interviewId: 500, provider: "OUTLOOK_365", calendarEventId: "evt-9", status: "SYNCED", tenantId: tenant,
        });
        expect(row).toMatchObject({ calendarProvider: "OUTLOOK_365", calendarEventId: "evt-9", calendarSyncStatus: "SYNCED" });
        expect(prisma.interview.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ calendarSyncedAt: expect.any(Date) }) }),
        );
    });

    it("refuses unknown status values", async () => {
        await expect(
            service.markCalendarSync({ interviewId: 500, provider: "P", calendarEventId: "e", status: "MAYBE", tenantId: tenant }),
        ).rejects.toMatchObject({ details: { code: "HR-RECRUITMENT-SCHEDULE-CALENDAR-ARGS" } });
    });

    it("404s on an unknown interview", async () => {
        prisma.interview.findFirst.mockResolvedValue(null);
        await expect(
            service.markCalendarSync({ interviewId: 404, provider: "P", calendarEventId: "e", status: "SYNCED", tenantId: tenant }),
        ).rejects.toMatchObject({ status: 404 });
    });
});

// ── the ledger read ──────────────────────────────────────────────────────────

describe("interviewSchedule.listLifecycleEvents", () => {
    it("returns the interview's history oldest-first", async () => {
        prisma.interview.findFirst.mockResolvedValue(interviewRow());
        prisma.interviewLifecycleEvent.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

        const rows = await service.listLifecycleEvents({ interviewId: 500, tenantId: tenant });
        expect(rows).toHaveLength(2);
        expect(prisma.interviewLifecycleEvent.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ interviewId: 500 }) }),
        );
    });
});
